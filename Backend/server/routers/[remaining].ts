/**
 * ============================================================================
 * TOUS LES ROUTERS RESTANTS - TITAN V31.4
 * ============================================================================
 * 
 * Ce fichier contient tous les routers manquants en version complète.
 * À séparer dans des fichiers individuels lors de l'implémentation.
 */

import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

// ============================================================================
// MEDICAL ACTS ROUTER (avec triggers commissions)
// ============================================================================

export const medicalActsRouter = router({
  list: protectedProcedure
    .input(z.object({
      encounterId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      doctorId: z.string().uuid().optional(),
      limit: z.number().min(1).max(100).optional().default(50),
      offset: z.number().min(0).optional().default(0),
    }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let query = database.select().from(schema.medicalActs).limit(input.limit).offset(input.offset);

      const conditions = [];
      if (input.encounterId) conditions.push(sql`encounter_id = ${input.encounterId}`);
      if (input.patientId) conditions.push(sql`patient_id = ${input.patientId}`);
      if (input.doctorId) conditions.push(sql`doctor_id = ${input.doctorId}`);

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      return await query;
    }),

  create: protectedProcedure
    .input(z.object({
      encounterId: z.string().uuid(),
      patientId: z.string().uuid(),
      doctorId: z.string().uuid().optional(),
      billingCodeId: z.string().uuid().optional(),
      price: z.number().positive(),
      commissionInternalRate: z.number().min(0).max(1).optional(),
      commissionExternalRate: z.number().min(0).max(1).optional(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Trigger compute_act_commissions() calcule automatiquement les montants
      const act = await database.insert(schema.medicalActs).values({
        encounterId: input.encounterId,
        patientId: input.patientId,
        doctorId: input.doctorId || null,
        billingCodeId: input.billingCodeId || null,
        price: input.price.toString(),
        commissionInternalRate: input.commissionInternalRate?.toString() || "0",
        commissionExternalRate: input.commissionExternalRate?.toString() || "0",
        performedAt: new Date(),
      }).returning();

      console.log(`[MedicalActs] ✅ Act created with auto-calculated commissions`);

      return act[0];
    }),
});

// ============================================================================
// PRESCRIPTIONS ROUTER
// ============================================================================

export const prescriptionsRouter = router({
  list: protectedProcedure
    .input(z.object({
      encounterId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      doctorId: z.string().uuid().optional(),
      status: z.enum(["active", "completed", "cancelled"]).optional(),
      limit: z.number().min(1).max(100).optional().default(50),
      offset: z.number().min(0).optional().default(0),
    }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let query = database.select().from(schema.prescriptions).limit(input.limit).offset(input.offset);

      const conditions = [];
      if (input.encounterId) conditions.push(sql`encounter_id = ${input.encounterId}`);
      if (input.patientId) conditions.push(sql`patient_id = ${input.patientId}`);
      if (input.doctorId) conditions.push(sql`doctor_id = ${input.doctorId}`);
      if (input.status) conditions.push(sql`status = ${input.status}`);

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      return await query;
    }),

  create: protectedProcedure
    .input(z.object({
      encounterId: z.string().uuid(),
      patientId: z.string().uuid(),
      doctorId: z.string().uuid().optional(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const prescription = await database.insert(schema.prescriptions).values({
        encounterId: input.encounterId,
        patientId: input.patientId,
        doctorId: input.doctorId || null,
        status: "active",
      }).returning();

      return prescription[0];
    }),

  addMedication: protectedProcedure
    .input(z.object({
      prescriptionId: z.string().uuid(),
      drugId: z.string().uuid(),
      dosage: z.string(),
      quantity: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const medication = await database.insert(schema.medicationOrders).values({
        prescriptionId: input.prescriptionId,
        drugId: input.drugId,
        dosage: input.dosage,
        quantity: input.quantity,
      }).returning();

      return medication[0];
    }),

  getItems: protectedProcedure
    .input(z.object({ prescriptionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      return await database.select().from(schema.medicationOrders).where(sql`prescription_id = ${input.prescriptionId}`);
    }),
});

// ============================================================================
// PHARMACY ROUTER (avec triggers stock)
// ============================================================================

export const pharmacyRouter = router({
  listItems: protectedProcedure
    .input(z.object({
      centerId: z.string().uuid().optional(),
      drugId: z.string().uuid().optional(),
      limit: z.number().min(1).max(100).optional().default(50),
    }))
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const centerId = input.centerId || ctx.user.centerId;
      if (!centerId) throw new TRPCError({ code: "FORBIDDEN", message: "Must specify center" });

      let query = database.select().from(schema.pharmacyItems).where(sql`center_id = ${centerId}`).limit(input.limit);

      if (input.drugId) {
        query = query.where(sql`drug_id = ${input.drugId}`);
      }

      return await query;
    }),

  createTransaction: protectedProcedure
    .input(z.object({
      itemId: z.string().uuid(),
      transactionType: z.enum(["in", "out"]),
      quantity: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Trigger fn_update_pharmacy_stock() met à jour current_stock automatiquement
      const transaction = await database.insert(schema.pharmacyTransactions).values({
        itemId: input.itemId,
        transactionType: input.transactionType,
        quantity: input.quantity,
      }).returning();

      console.log(`[Pharmacy] ✅ Transaction created, stock updated by trigger`);

      return transaction[0];
    }),

  getStock: protectedProcedure
    .input(z.object({ itemId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const item = await database.select().from(schema.pharmacyItems).where(sql`id = ${input.itemId}`).limit(1);

      if (!item || item.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      }

      return { itemId: input.itemId, currentStock: item[0].currentStock };
    }),
});

// ============================================================================
// DRUGS ROUTER
// ============================================================================

export const drugsRouter = router({
  list: protectedProcedure
    .input(z.object({
      search: z.string().optional(),
      limit: z.number().min(1).max(100).optional().default(50),
    }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let query = database.select().from(schema.drugs).limit(input.limit);

      if (input.search) {
        query = query.where(sql`name ILIKE ${'%' + input.search + '%'}`);
      }

      return await query;
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      code: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const drug = await database.insert(schema.drugs).values({
        name: input.name,
        code: input.code || null,
      }).returning();

      return drug[0];
    }),
});

// ============================================================================
// ROLES & PERMISSIONS ROUTER
// ============================================================================

export const rolesRouter = router({
  listRoles: protectedProcedure.query(async () => {
    return await require("../db").getAllRoles();
  }),

  listPermissions: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    return await database.select().from(schema.permissions);
  }),

  getRolePermissions: protectedProcedure
    .input(z.object({ roleId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const result = await database
        .select({ permission: schema.permissions })
        .from(schema.rolePermissions)
        .innerJoin(schema.permissions, sql`${schema.rolePermissions.permissionId} = ${schema.permissions.id}`)
        .where(sql`${schema.rolePermissions.roleId} = ${input.roleId}`);

      return result.map((r) => r.permission);
    }),

  assignPermission: protectedProcedure
    .input(z.object({
      roleId: z.string().uuid(),
      permissionId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await database.insert(schema.rolePermissions).values({
        roleId: input.roleId,
        permissionId: input.permissionId,
      });

      return { success: true };
    }),
});

// ============================================================================
// STATS ROUTER (vues PostgreSQL)
// ============================================================================

export const statsRouter = router({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const database = await getDb();
    if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    // Patient summary
    const patientSummary = await database.execute(sql`SELECT * FROM v_patient_summary LIMIT 10`);

    // Upcoming appointments
    const upcomingAppointments = await database.execute(sql`SELECT * FROM v_upcoming_appointments LIMIT 10`);

    // Invoice summary
    const invoiceSummary = await database.execute(sql`SELECT * FROM v_invoice_summary`);

    // Doctor commissions
    const doctorCommissions = await database.execute(sql`SELECT * FROM v_doctor_commissions LIMIT 10`);

    return {
      patientSummary: patientSummary.rows,
      upcomingAppointments: upcomingAppointments.rows,
      invoiceSummary: invoiceSummary.rows,
      doctorCommissions: doctorCommissions.rows,
    };
  }),

  patients: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    const result = await database.execute(sql`SELECT * FROM v_patient_summary`);
    return result.rows;
  }),

  upcomingAppointments: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    const result = await database.execute(sql`SELECT * FROM v_upcoming_appointments`);
    return result.rows;
  }),

  invoices: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    const result = await database.execute(sql`SELECT * FROM v_invoice_summary`);
    return result.rows;
  }),

  doctorCommissions: protectedProcedure
    .input(z.object({ doctorId: z.string().uuid().optional() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const query = input.doctorId
        ? sql`SELECT * FROM v_doctor_commissions WHERE doctor_id = ${input.doctorId}`
        : sql`SELECT * FROM v_doctor_commissions`;

      const result = await database.execute(query);
      return result.rows;
    }),
});

// ============================================================================
// DOCUMENTS ROUTER
// ============================================================================

export const documentsRouter = router({
  list: protectedProcedure
    .input(z.object({
      patientId: z.string().uuid().optional(),
      limit: z.number().min(1).max(100).optional().default(50),
    }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let query = database.select().from(schema.documents).limit(input.limit);

      if (input.patientId) {
        query = query.where(sql`patient_id = ${input.patientId}`);
      }

      return await query;
    }),

  create: protectedProcedure
    .input(z.object({
      patientId: z.string().uuid(),
      filename: z.string(),
      filePath: z.string(),
      mimeType: z.string().optional(),
      sizeBytes: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const document = await database.insert(schema.documents).values({
        centerId: ctx.user.centerId || null,
        patientId: input.patientId,
        filename: input.filename,
        filePath: input.filePath,
        mimeType: input.mimeType || null,
        sizeBytes: input.sizeBytes || null,
      }).returning();

      return document[0];
    }),
});