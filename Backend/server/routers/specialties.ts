import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * ============================================================================
 * SPECIALTIES ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des spécialités médicales.
 * 
 * Fonctionnalités :
 * - CRUD spécialités (admin only pour create/update/delete)
 * - Liste publique pour tous les users (dropdown doctors)
 * - Compteur de doctors par spécialité
 * 
 * ⚠️ Les spécialités sont globales (pas de center_id)
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const specialtySchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().min(1, "Code is required").max(20),
  description: z.string().optional(),
});

// ============================================================================
// SPECIALTIES ROUTER
// ============================================================================

export const specialtiesRouter = router({
  /**
   * 📋 GET /api/specialties/list
   * 
   * Liste de toutes les spécialités.
   * Accessible à tous les users authentifiés (pour les dropdowns).
   */
  list: protectedProcedure.query(async () => {
    console.log("[Specialties] Listing all specialties");

    const specialties = await db.getAllSpecialties();

    console.log(`[Specialties] ✅ Found ${specialties.length} specialties`);

    return specialties;
  }),

  /**
   * 👤 GET /api/specialties/:id
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

      console.log(`[Specialties] Getting specialty: ${input.id}`);

      const specialty = await database
        .select()
        .from(schema.specialties)
        .where((s) => s.id.eq(input.id))
        .limit(1);

      if (!specialty || specialty.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Specialty not found",
        });
      }

      console.log(`[Specialties] ✅ Specialty retrieved: ${specialty[0].name}`);

      return specialty[0];
    }),

  /**
   * ➕ POST /api/specialties (Admin only)
   * 
   * Crée une nouvelle spécialité.
   * Seuls les superadmins peuvent créer des spécialités.
   */
  create: adminProcedure
    .input(specialtySchema)
    .mutation(async ({ input }) => {
      console.log(`[Specialties] Creating specialty: ${input.name}`);

      // Vérifier code unique
      const specialties = await db.getAllSpecialties();
      const existing = specialties.find((s) => s.code === input.code);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Specialty code ${input.code} already exists`,
        });
      }

      // Créer spécialité
      const specialty = await db.createSpecialty({
        name: input.name,
        code: input.code,
        description: input.description || null,
      });

      if (!specialty) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create specialty",
        });
      }

      console.log(`[Specialties] ✅ Specialty created: ${specialty.code}`);

      return specialty;
    }),

  /**
   * ✏️ PUT /api/specialties/:id (Admin only)
   */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: specialtySchema.partial(),
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

      console.log(`[Specialties] Updating specialty: ${input.id}`);

      // Vérifier que la spécialité existe
      const existing = await database
        .select()
        .from(schema.specialties)
        .where((s) => s.id.eq(input.id))
        .limit(1);

      if (!existing || existing.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Specialty not found",
        });
      }

      // Vérifier code unique si changé
      if (input.data.code && input.data.code !== existing[0].code) {
        const specialties = await db.getAllSpecialties();
        const duplicate = specialties.find((s) => s.code === input.data.code);

        if (duplicate) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Specialty code ${input.data.code} already exists`,
          });
        }
      }

      // Mise à jour
      const specialty = await database
        .update(schema.specialties)
        .set({
          ...input.data,
        })
        .where((s) => s.id.eq(input.id))
        .returning();

      if (!specialty || specialty.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update specialty",
        });
      }

      console.log(`[Specialties] ✅ Specialty updated: ${specialty[0].code}`);

      return specialty[0];
    }),

  /**
   * ❌ DELETE /api/specialties/:id (Admin only)
   * 
   * Supprime une spécialité.
   * Vérifie qu'aucun doctor n'utilise cette spécialité.
   */
  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Specialties] Deleting specialty: ${input.id}`);

      // Vérifier qu'aucun doctor n'utilise cette spécialité
      const doctors = await database
        .select()
        .from(schema.doctors)
        .where((d) => d.specialtyId.eq(input.id));

      if (doctors.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot delete specialty: ${doctors.length} doctor(s) are using it`,
        });
      }

      // Suppression
      await database
        .delete(schema.specialties)
        .where((s) => s.id.eq(input.id));

      console.log(`[Specialties] ✅ Specialty deleted: ${input.id}`);

      return { success: true };
    }),

  /**
   * 📊 GET /api/specialties/:id/stats
   * 
   * Statistiques d'une spécialité.
   */
  stats: protectedProcedure
    .input(z.object({ specialtyId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Specialties] Getting stats for specialty: ${input.specialtyId}`);

      // Compter doctors avec cette spécialité
      const doctors = await database
        .select()
        .from(schema.doctors)
        .where((d) => d.specialtyId.eq(input.specialtyId));

      const stats = {
        totalDoctors: doctors.length,
        activeDoctors: doctors.filter((d) => d.isActive).length,
      };

      console.log(`[Specialties] ✅ Stats retrieved:`, stats);

      return stats;
    }),

  /**
   * 📋 GET /api/specialties/with-counts
   * 
   * Liste des spécialités avec compteur de doctors.
   */
  listWithCounts: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
      });
    }

    console.log("[Specialties] Listing specialties with doctor counts");

    const specialties = await db.getAllSpecialties();

    // Compter doctors pour chaque spécialité
    const withCounts = await Promise.all(
      specialties.map(async (specialty) => {
        const doctors = await database
          .select()
          .from(schema.doctors)
          .where((d) => d.specialtyId.eq(specialty.id));

        return {
          ...specialty,
          doctorCount: doctors.length,
          activeDoctorCount: doctors.filter((d) => d.isActive).length,
        };
      })
    );

    console.log(`[Specialties] ✅ Found ${withCounts.length} specialties with counts`);

    return withCounts;
  }),
});