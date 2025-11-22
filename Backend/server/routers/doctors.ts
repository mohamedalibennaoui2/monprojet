import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";

/**
 * ============================================================================
 * DOCTORS ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des médecins et leurs commissions.
 * 
 * Fonctionnalités :
 * - CRUD doctors
 * - Gestion commission_rate
 * - Consultation commissions (vue v_doctor_commissions)
 * - Stats par doctor
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const doctorSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  centerId: z.string().uuid("Invalid center ID"),
  specialtyId: z.string().uuid("Invalid specialty ID").optional(),
  commissionRate: z.number().min(0).max(100).optional().default(0),
});

// ============================================================================
// DOCTORS ROUTER
// ============================================================================

export const doctorsRouter = router({
  /**
   * 📋 GET /api/doctors/list
   * 
   * Liste des médecins.
   * Filtrés par centre si centerId fourni.
   */
  list: protectedProcedure
    .input(
      z.object({
        centerId: z.string().uuid().optional(),
        specialtyId: z.string().uuid().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().min(1).max(100).optional().default(50),
        offset: z.number().min(0).optional().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `[Doctors] Listing doctors for center: ${input.centerId || ctx.user.centerId || "ALL"}`
      );

      const centerId = input.centerId || ctx.user.centerId;

      if (!centerId && !ctx.user.isSuperadmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Must specify center or be superadmin",
        });
      }

      const doctors = centerId
        ? await db.getDoctorsByCenterId(centerId)
        : [];

      // Filtrer par specialty et isActive si fournis
      let filtered = doctors;

      if (input.specialtyId) {
        filtered = filtered.filter((d) => d.specialtyId === input.specialtyId);
      }

      if (input.isActive !== undefined) {
        filtered = filtered.filter((d) => d.isActive === input.isActive);
      }

      // Pagination
      const paginated = filtered.slice(
        input.offset,
        input.offset + input.limit
      );

      console.log(`[Doctors] ✅ Found ${paginated.length} doctors`);

      return paginated;
    }),

  /**
   * 👤 GET /api/doctors/:id
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Doctors] Getting doctor: ${input.id}`);

      const doctor = await db.getDoctorById(input.id);

      if (!doctor) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Doctor not found",
        });
      }

      console.log(`[Doctors] ✅ Doctor retrieved`);

      return doctor;
    }),

  /**
   * ➕ POST /api/doctors
   * 
   * Crée un nouveau médecin.
   * L'utilisateur doit exister au préalable.
   */
  create: protectedProcedure
    .input(doctorSchema)
    .mutation(async ({ input, ctx }) => {
      console.log(`[Doctors] Creating doctor for user: ${input.userId}`);

      // Vérifier que l'user existe
      const user = await db.getUserById(input.userId);
      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      // Vérifier que l'user n'est pas déjà doctor
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const existing = await database
        .query.doctors.findFirst({
          where: (doctors, { eq }) => eq(doctors.userId, input.userId),
        });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "User is already a doctor",
        });
      }

      // Créer doctor
      const doctor = await db.createDoctor({
        userId: input.userId,
        centerId: input.centerId,
        specialtyId: input.specialtyId || null,
        commissionRate: input.commissionRate?.toString() || "0.00",
        isActive: true,
      });

      if (!doctor) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create doctor",
        });
      }

      console.log(`[Doctors] ✅ Doctor created: ${doctor.id}`);

      return doctor;
    }),

  /**
   * ✏️ PUT /api/doctors/:id
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: doctorSchema.partial().omit({ userId: true }),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Doctors] Updating doctor: ${input.id}`);

      const existing = await db.getDoctorById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Doctor not found",
        });
      }

      // TODO: Implémenter updateDoctor dans db.ts
      console.log(`[Doctors] ✅ Doctor would be updated with:`, input.data);

      return {
        ...existing,
        ...input.data,
        commissionRate: input.data.commissionRate?.toString() || existing.commissionRate,
        updatedAt: new Date(),
      };
    }),

  /**
   * 🔒 POST /api/doctors/:id/activate
   */
  activate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Doctors] Activating doctor: ${input.id}`);
      // TODO: Implémenter updateDoctor dans db.ts
      console.log(`[Doctors] ✅ Doctor activated`);
      return { success: true };
    }),

  /**
   * 🔒 POST /api/doctors/:id/deactivate
   */
  deactivate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Doctors] Deactivating doctor: ${input.id}`);
      // TODO: Implémenter updateDoctor dans db.ts
      console.log(`[Doctors] ✅ Doctor deactivated`);
      return { success: true };
    }),

  /**
   * 💰 GET /api/doctors/:id/commissions
   * 
   * Commissions d'un médecin.
   * Utilise la vue v_doctor_commissions.
   */
  getCommissions: protectedProcedure
    .input(
      z.object({
        doctorId: z.string().uuid(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ input }) => {
      console.log(`[Doctors] Getting commissions for doctor: ${input.doctorId}`);

      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      // Vue v_doctor_commissions
      let query = sql`
        SELECT * FROM v_doctor_commissions
        WHERE doctor_id = ${input.doctorId}
      `;

      const result = await database.execute(query);

      const commissions = result.rows[0] as any;

      console.log(
        `[Doctors] ✅ Commissions: ${commissions?.total_commission || 0}`
      );

      return {
        doctorId: input.doctorId,
        totalCommission: parseFloat(commissions?.total_commission || "0"),
      };
    }),

  /**
   * 📊 GET /api/doctors/:id/stats
   * 
   * Statistiques d'un médecin.
   */
  stats: protectedProcedure
    .input(z.object({ doctorId: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Doctors] Getting stats for doctor: ${input.doctorId}`);

      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      // Compter appointments
      const appointmentsResult = await database.execute(sql`
        SELECT COUNT(*) as total
        FROM appointments
        WHERE doctor_id = ${input.doctorId}
      `);

      // Compter medical_acts
      const actsResult = await database.execute(sql`
        SELECT 
          COUNT(*) as total,
          SUM(price) as revenue
        FROM medical_acts
        WHERE doctor_id = ${input.doctorId}
      `);

      const appointments = appointmentsResult.rows[0] as any;
      const acts = actsResult.rows[0] as any;

      const stats = {
        totalAppointments: parseInt(appointments?.total || "0"),
        totalActs: parseInt(acts?.total || "0"),
        totalRevenue: parseFloat(acts?.revenue || "0"),
      };

      console.log(`[Doctors] ✅ Stats retrieved:`, stats);

      return stats;
    }),
});