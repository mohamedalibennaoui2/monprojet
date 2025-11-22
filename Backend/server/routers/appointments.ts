import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { PGPService } from "../services/pgp";

/**
 * ============================================================================
 * APPOINTMENTS ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des rendez-vous compatible TITAN V31.4.
 * 
 * Fonctionnalités :
 * - CRUD appointments avec RLS automatique
 * - Chiffrement PGP des notes (notes_encrypted BYTEA)
 * - Anti-double-booking (contrainte unique_appt_schedule)
 * - Filtrage par statut (pending, confirmed, completed, cancelled)
 * 
 * ⚠️ CHIFFREMENT PGP :
 * - notes en entrée (texte clair) → notes_encrypted en DB (BYTEA)
 * - notes_encrypted en DB (BYTEA) → notes en sortie (texte déchiffré)
 * 
 * Contrainte PostgreSQL active :
 * - unique_appt_schedule : UNIQUE(patient_id, scheduled_from, scheduled_to, center_id)
 * 
 * Trigger PostgreSQL actif :
 * - set_appts_upd : Met à jour updated_at automatiquement
 */

// ============================================================================
// SCHEMAS DE VALIDATION
// ============================================================================

const appointmentSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  doctorId: z.string().uuid("Invalid doctor ID").optional().nullable(),
  scheduledFrom: z.string().datetime("Invalid datetime format"),
  scheduledTo: z.string().datetime("Invalid datetime format"),
  status: z.enum(["pending", "confirmed", "completed", "cancelled"]).optional(),
  type: z.string().optional().nullable(),
  notes: z.string().optional().nullable(), // Texte en clair, sera chiffré
});

const listSchema = z.object({
  patientId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  status: z.enum(["pending", "confirmed", "completed", "cancelled"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

// ============================================================================
// APPOINTMENTS ROUTER
// ============================================================================

export const appointmentsRouter = router({
  /**
   * 📋 GET /api/appointments/list
   * 
   * Liste des rendez-vous avec filtres.
   * Filtrée automatiquement par center_id (RLS).
   * 
   * @input { patientId?, doctorId?, status?, from?, to?, limit?, offset? }
   * @returns Liste des rendez-vous avec notes déchiffrées
   */
  list: protectedProcedure
    .input(listSchema)
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(
        `[Appointments] Listing appointments for center: ${ctx.user.centerId || "ALL"}`
      );

      // Construire la requête avec filtres
      let query = database
        .select()
        .from(schema.appointments)
        .limit(input.limit)
        .offset(input.offset);

      // Filtres optionnels
      const conditions = [];
      if (input.patientId) {
        conditions.push(sql`patient_id = ${input.patientId}`);
      }
      if (input.doctorId) {
        conditions.push(sql`doctor_id = ${input.doctorId}`);
      }
      if (input.status) {
        conditions.push(sql`status = ${input.status}`);
      }
      if (input.from) {
        conditions.push(sql`scheduled_from >= ${input.from}`);
      }
      if (input.to) {
        conditions.push(sql`scheduled_to <= ${input.to}`);
      }

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      const appointments = await query;

      // Déchiffrer les notes pour chaque rendez-vous
      const appointmentsWithNotes = await Promise.all(
        appointments.map(async (appt) => {
          const notes = await PGPService.decryptOptional(
            appt.notesEncrypted as Buffer | null
          );

          return {
            ...appt,
            notes, // Texte déchiffré
            notesEncrypted: undefined, // Ne pas exposer le BYTEA
          };
        })
      );

      console.log(`[Appointments] ✅ Found ${appointments.length} appointments`);

      return appointmentsWithNotes;
    }),

  /**
   * 👤 GET /api/appointments/:id
   * 
   * Récupère un rendez-vous par ID avec notes déchiffrées.
   * Filtré automatiquement par RLS.
   * 
   * @input { id: UUID }
   * @returns Appointment complet avec notes en clair
   * @throws NOT_FOUND si appointment introuvable ou hors centre
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Appointments] Getting appointment: ${input.id}`);

      const appointment = await db.getAppointmentById(input.id);

      if (!appointment) {
        console.error(`[Appointments] Appointment not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }

      // Déchiffrer les notes
      const notes = await PGPService.decryptOptional(
        appointment.notesEncrypted as Buffer | null
      );

      console.log(`[Appointments] ✅ Appointment retrieved and decrypted`);

      return {
        ...appointment,
        notes,
        notesEncrypted: undefined,
      };
    }),

  /**
   * ➕ POST /api/appointments
   * 
   * Crée un nouveau rendez-vous.
   * Chiffre automatiquement les notes avec PGP.
   * 
   * Workflow :
   * 1. Validation données
   * 2. Vérification disponibilité (pas de double-booking)
   * 3. Chiffrement notes avec PGPService.encrypt()
   * 4. Insertion avec center_id du user (RLS)
   * 
   * @input AppointmentSchema
   * @returns Appointment créé avec notes en clair
   * @throws CONFLICT si double-booking
   * @throws FORBIDDEN si user sans centre
   */
  create: protectedProcedure
    .input(appointmentSchema)
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[Appointments] Creating appointment for patient: ${input.patientId}`
      );

      // Vérifier que l'utilisateur a un centre
      if (!ctx.user.centerId && !ctx.user.isSuperadmin) {
        console.error(`[Appointments] User ${ctx.user.username} has no center`);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You must be assigned to a center to create appointments",
        });
      }

      // Vérifier que le patient appartient au même centre (RLS le fait automatiquement)
      const patient = await db.getPatientById(input.patientId);
      if (!patient) {
        console.error(`[Appointments] Patient not found: ${input.patientId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found or not in your center",
        });
      }

      // Vérifier que scheduledFrom < scheduledTo
      const from = new Date(input.scheduledFrom);
      const to = new Date(input.scheduledTo);

      if (from >= to) {
        console.error(`[Appointments] Invalid time range: ${input.scheduledFrom} to ${input.scheduledTo}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Scheduled end time must be after start time",
        });
      }

      // Chiffrer les notes si présentes
      const notesEncrypted = await PGPService.encryptOptional(input.notes);

      console.log(
        `[Appointments] Notes encrypted: ${notesEncrypted ? "YES" : "NO"}`
      );

      try {
        // Créer le rendez-vous
        const appointment = await db.createAppointment({
          patientId: input.patientId,
          doctorId: input.doctorId || null,
          centerId: ctx.user.centerId!,
          scheduledFrom: from,
          scheduledTo: to,
          status: input.status || "pending",
          type: input.type || null,
          notesEncrypted: notesEncrypted || null,
        });

        if (!appointment) {
          console.error("[Appointments] Failed to create appointment");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create appointment",
          });
        }

        console.log(`[Appointments] ✅ Appointment created: ${appointment.id}`);

        // Retourner avec notes déchiffrées
        return {
          ...appointment,
          notes: input.notes || null,
          notesEncrypted: undefined,
        };
      } catch (error: any) {
        // Gérer l'erreur de double-booking (contrainte unique_appt_schedule)
        if (error.code === "23505" || error.message?.includes("unique_appt_schedule")) {
          console.error(
            `[Appointments] Double-booking detected for patient ${input.patientId}`
          );
          throw new TRPCError({
            code: "CONFLICT",
            message: "This patient already has an appointment at this time",
          });
        }

        console.error("[Appointments] Error creating appointment:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create appointment",
        });
      }
    }),

  /**
   * ✏️ PUT /api/appointments/:id
   * 
   * Met à jour un rendez-vous.
   * Re-chiffre les notes si modifiées.
   * 
   * @input { id, data: Partial<AppointmentSchema> }
   * @returns Appointment mis à jour avec notes déchiffrées
   * @throws NOT_FOUND si appointment introuvable
   * @throws CONFLICT si double-booking après modification
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: appointmentSchema.partial(),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Appointments] Updating appointment: ${input.id}`);

      // Vérifier que le rendez-vous existe
      const existing = await db.getAppointmentById(input.id);
      if (!existing) {
        console.error(`[Appointments] Appointment not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }

      // Préparer les données de mise à jour
      const updateData: any = {};

      if (input.data.scheduledFrom !== undefined) {
        updateData.scheduledFrom = new Date(input.data.scheduledFrom);
      }
      if (input.data.scheduledTo !== undefined) {
        updateData.scheduledTo = new Date(input.data.scheduledTo);
      }
      if (input.data.status !== undefined) {
        updateData.status = input.data.status;
      }
      if (input.data.type !== undefined) {
        updateData.type = input.data.type;
      }
      if (input.data.doctorId !== undefined) {
        updateData.doctorId = input.data.doctorId;
      }

      // Re-chiffrer les notes si modifiées
      if (input.data.notes !== undefined) {
        updateData.notesEncrypted = await PGPService.encryptOptional(
          input.data.notes
        );
        console.log(`[Appointments] Notes re-encrypted`);
      }

      try {
        // Mise à jour
        const appointment = await db.updateAppointment(input.id, updateData);

        if (!appointment) {
          console.error(`[Appointments] Failed to update: ${input.id}`);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to update appointment",
          });
        }

        // Déchiffrer les notes pour la réponse
        const notes = await PGPService.decryptOptional(
          appointment.notesEncrypted as Buffer | null
        );

        console.log(`[Appointments] ✅ Appointment updated: ${appointment.id}`);

        return {
          ...appointment,
          notes,
          notesEncrypted: undefined,
        };
      } catch (error: any) {
        // Gérer l'erreur de double-booking
        if (error.code === "23505" || error.message?.includes("unique_appt_schedule")) {
          console.error(`[Appointments] Double-booking after update: ${input.id}`);
          throw new TRPCError({
            code: "CONFLICT",
            message: "This patient already has an appointment at this time",
          });
        }

        console.error("[Appointments] Error updating appointment:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update appointment",
        });
      }
    }),

  /**
   * ❌ POST /api/appointments/:id/cancel
   * 
   * Annule un rendez-vous (met status = 'cancelled').
   * 
   * @input { id, reason? }
   * @returns { success: true }
   */
  cancel: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Appointments] Cancelling appointment: ${input.id}`);

      const appointment = await db.getAppointmentById(input.id);
      if (!appointment) {
        console.error(`[Appointments] Appointment not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }

      // Ajouter la raison d'annulation aux notes (chiffrées)
      let notes = await PGPService.decryptOptional(
        appointment.notesEncrypted as Buffer | null
      );

      if (input.reason) {
        const timestamp = new Date().toISOString();
        notes = notes
          ? `${notes}\n\n[CANCELLED ${timestamp}] ${input.reason}`
          : `[CANCELLED ${timestamp}] ${input.reason}`;
      }

      const notesEncrypted = await PGPService.encryptOptional(notes);

      await db.updateAppointment(input.id, {
        status: "cancelled",
        notesEncrypted: notesEncrypted || null,
      });

      console.log(`[Appointments] ✅ Appointment cancelled: ${input.id}`);

      return { success: true };
    }),

  /**
   * 📊 GET /api/appointments/upcoming
   * 
   * Rendez-vous à venir (scheduled_from > NOW()).
   * Utilise la vue v_upcoming_appointments si disponible.
   * 
   * @input { limit? }
   * @returns Liste des rendez-vous à venir
   */
  upcoming: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).optional().default(20) }))
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Appointments] Getting upcoming appointments`);

      // Utiliser la vue PostgreSQL si disponible
      const result = await database.execute(sql`
        SELECT * FROM v_upcoming_appointments
        LIMIT ${input.limit}
      `);

      const appointments = result.rows;

      console.log(`[Appointments] ✅ Found ${appointments.length} upcoming appointments`);

      return appointments;
    }),
});