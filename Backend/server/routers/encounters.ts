import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { PGPService } from "../services/pgp";

/**
 * ============================================================================
 * ENCOUNTERS ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des consultations (encounters).
 * 
 * Fonctionnalités :
 * - CRUD encounters avec RLS
 * - Chiffrement PGP du plan_encrypted
 * - Finalisation encounter (is_finalized)
 * - Lien avec appointments
 * - Gestion medical_acts associés
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const encounterSchema = z.object({
  appointmentId: z.string().uuid().optional(),
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  plan: z.string().optional(), // Texte clair, sera chiffré
});

// ============================================================================
// ENCOUNTERS ROUTER
// ============================================================================

export const encountersRouter = router({
  /**
   * 📋 GET /api/encounters/list
   */
  list: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid().optional(),
        doctorId: z.string().uuid().optional(),
        isFinalized: z.boolean().optional(),
        limit: z.number().min(1).max(100).optional().default(50),
        offset: z.number().min(0).optional().default(0),
      })
    )
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log("[Encounters] Listing encounters");

      let query = database
        .select()
        .from(schema.encounters)
        .limit(input.limit)
        .offset(input.offset);

      const conditions = [];
      if (input.patientId) {
        conditions.push(sql`patient_id = ${input.patientId}`);
      }
      if (input.doctorId) {
        conditions.push(sql`doctor_id = ${input.doctorId}`);
      }
      if (input.isFinalized !== undefined) {
        conditions.push(sql`is_finalized = ${input.isFinalized}`);
      }

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      const encounters = await query;

      // Déchiffrer les plans
      const encountersWithPlan = await Promise.all(
        encounters.map(async (enc) => {
          const plan = await PGPService.decryptOptional(
            enc.planEncrypted as Buffer | null
          );

          return {
            ...enc,
            plan,
            planEncrypted: undefined,
          };
        })
      );

      console.log(`[Encounters] ✅ Found ${encounters.length} encounters`);

      return encountersWithPlan;
    }),

  /**
   * 👤 GET /api/encounters/:id
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Encounters] Getting encounter: ${input.id}`);

      const encounter = await database
        .select()
        .from(schema.encounters)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!encounter || encounter.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Encounter not found",
        });
      }

      // Déchiffrer plan
      const plan = await PGPService.decryptOptional(
        encounter[0].planEncrypted as Buffer | null
      );

      console.log(`[Encounters] ✅ Encounter retrieved and decrypted`);

      return {
        ...encounter[0],
        plan,
        planEncrypted: undefined,
      };
    }),

  /**
   * ➕ POST /api/encounters
   */
  create: protectedProcedure
    .input(encounterSchema)
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Encounters] Creating encounter for patient: ${input.patientId}`);

      // Chiffrer plan si présent
      const planEncrypted = await PGPService.encryptOptional(input.plan);

      console.log(`[Encounters] Plan encrypted: ${planEncrypted ? "YES" : "NO"}`);

      // Créer encounter
      const encounter = await database
        .insert(schema.encounters)
        .values({
          appointmentId: input.appointmentId || null,
          patientId: input.patientId,
          doctorId: input.doctorId || null,
          centerId: ctx.user.centerId || null,
          planEncrypted: planEncrypted || null,
          isFinalized: false,
        })
        .returning();

      if (!encounter || encounter.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create encounter",
        });
      }

      console.log(`[Encounters] ✅ Encounter created: ${encounter[0].id}`);

      return {
        ...encounter[0],
        plan: input.plan || null,
        planEncrypted: undefined,
      };
    }),

  /**
   * ✏️ PUT /api/encounters/:id
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: encounterSchema.partial().omit({ appointmentId: true, patientId: true }),
      })
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Encounters] Updating encounter: ${input.id}`);

      // Vérifier que l'encounter existe
      const existing = await database
        .select()
        .from(schema.encounters)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!existing || existing.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Encounter not found",
        });
      }

      // Préparer update
      const updateData: any = {};

      if (input.data.doctorId !== undefined) {
        updateData.doctorId = input.data.doctorId;
      }

      // Re-chiffrer plan si modifié
      if (input.data.plan !== undefined) {
        updateData.planEncrypted = await PGPService.encryptOptional(
          input.data.plan
        );
        console.log(`[Encounters] Plan re-encrypted`);
      }

      // Update
      const encounter = await database
        .update(schema.encounters)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(sql`id = ${input.id}`)
        .returning();

      if (!encounter || encounter.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update encounter",
        });
      }

      // Déchiffrer pour réponse
      const plan = await PGPService.decryptOptional(
        encounter[0].planEncrypted as Buffer | null
      );

      console.log(`[Encounters] ✅ Encounter updated: ${encounter[0].id}`);

      return {
        ...encounter[0],
        plan,
        planEncrypted: undefined,
      };
    }),

  /**
   * ✅ POST /api/encounters/:id/finalize
   */
  finalize: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Encounters] Finalizing encounter: ${input.id}`);

      const encounter = await database
        .update(schema.encounters)
        .set({
          isFinalized: true,
          updatedAt: new Date(),
        })
        .where(sql`id = ${input.id}`)
        .returning();

      if (!encounter || encounter.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Encounter not found",
        });
      }

      console.log(`[Encounters] ✅ Encounter finalized: ${input.id}`);

      return { success: true };
    }),

  /**
   * 📋 GET /api/encounters/:id/medical-acts
   */
  getMedicalActs: protectedProcedure
    .input(z.object({ encounterId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Encounters] Getting medical acts for encounter: ${input.encounterId}`);

      const acts = await database
        .select()
        .from(schema.medicalActs)
        .where(sql`encounter_id = ${input.encounterId}`);

      console.log(`[Encounters] ✅ Found ${acts.length} medical acts`);

      return acts;
    }),
});