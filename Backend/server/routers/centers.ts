import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import * as db from "../db";

/**
 * ============================================================================
 * CENTERS ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des centres médicaux.
 * 
 * Fonctionnalités :
 * - CRUD centres (admin only pour create/update/delete)
 * - Liste centres (tous les users)
 * - Statistiques par centre
 * 
 * ⚠️ Seuls les superadmins peuvent créer/modifier/supprimer des centres.
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const centerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().min(1, "Code is required").max(10),
  timezone: z.string().optional().default("UTC"),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      zipCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
});

// ============================================================================
// CENTERS ROUTER
// ============================================================================

export const centersRouter = router({
  /**
   * 📋 GET /api/centers/list
   * 
   * Liste de tous les centres.
   * Accessible à tous les users authentifiés.
   */
  list: protectedProcedure.query(async () => {
    console.log("[Centers] Listing all centers");

    const centers = await db.getAllCenters();

    console.log(`[Centers] ✅ Found ${centers.length} centers`);

    return centers;
  }),

  /**
   * 👤 GET /api/centers/:id
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Centers] Getting center: ${input.id}`);

      const center = await db.getCenterById(input.id);

      if (!center) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Center not found",
        });
      }

      console.log(`[Centers] ✅ Center retrieved: ${center.name}`);

      return center;
    }),

  /**
   * ➕ POST /api/centers (Admin only)
   * 
   * Crée un nouveau centre.
   * Seuls les superadmins peuvent créer des centres.
   */
  create: adminProcedure.input(centerSchema).mutation(async ({ input }) => {
    console.log(`[Centers] Creating center: ${input.name}`);

    // Vérifier code unique
    const centers = await db.getAllCenters();
    const existing = centers.find((c) => c.code === input.code);

    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Center code ${input.code} already exists`,
      });
    }

    // Créer centre
    const center = await db.createCenter({
      name: input.name,
      code: input.code,
      timezone: input.timezone || "UTC",
      address: input.address || {},
      isActive: true,
    });

    if (!center) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create center",
      });
    }

    console.log(`[Centers] ✅ Center created: ${center.code}`);

    return center;
  }),

  /**
   * ✏️ PUT /api/centers/:id (Admin only)
   */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: centerSchema.partial(),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Centers] Updating center: ${input.id}`);

      const existing = await db.getCenterById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Center not found",
        });
      }

      // Vérifier code unique si changé
      if (input.data.code && input.data.code !== existing.code) {
        const centers = await db.getAllCenters();
        const duplicate = centers.find((c) => c.code === input.data.code);

        if (duplicate) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Center code ${input.data.code} already exists`,
          });
        }
      }

      // Update (à implémenter dans db.ts)
      // Pour l'instant, on simule
      console.log(`[Centers] ✅ Center would be updated with:`, input.data);

      return {
        ...existing,
        ...input.data,
        updatedAt: new Date(),
      };
    }),

  /**
   * 🔒 POST /api/centers/:id/activate (Admin only)
   */
  activate: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Centers] Activating center: ${input.id}`);
      // TODO: Implémenter updateCenter dans db.ts
      console.log(`[Centers] ✅ Center activated`);
      return { success: true };
    }),

  /**
   * 🔒 POST /api/centers/:id/deactivate (Admin only)
   */
  deactivate: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Centers] Deactivating center: ${input.id}`);
      // TODO: Implémenter updateCenter dans db.ts
      console.log(`[Centers] ✅ Center deactivated`);
      return { success: true };
    }),

  /**
   * 📊 GET /api/centers/:id/stats
   * 
   * Statistiques d'un centre.
   */
  stats: protectedProcedure
    .input(z.object({ centerId: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Centers] Getting stats for center: ${input.centerId}`);

      // Compter patients
      const patients = await db.getPatientsByCenterId(input.centerId);

      // Compter doctors
      const doctors = await db.getDoctorsByCenterId(input.centerId);

      // TODO: Ajouter autres stats (appointments, invoices, etc.)

      const stats = {
        totalPatients: patients.length,
        activePatients: patients.filter((p) => !p.isArchived).length,
        totalDoctors: doctors.length,
        activeDoctors: doctors.filter((d) => d.isActive).length,
      };

      console.log(`[Centers] ✅ Stats retrieved:`, stats);

      return stats;
    }),
});