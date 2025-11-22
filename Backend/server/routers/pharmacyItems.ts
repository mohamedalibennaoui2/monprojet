import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * ============================================================================
 * PHARMACY ITEMS ROUTER (COMPLET)
 * ============================================================================
 * 
 * Router pour la gestion complète des items de pharmacie.
 * 
 * Fonctionnalités :
 * - CRUD pharmacy_items
 * - Gestion stock avec triggers automatiques
 * - Alertes stock bas
 * - Historique transactions
 * - Recherche par drug
 * 
 * ⚠️ TRIGGERS AUTOMATIQUES :
 * - fn_update_pharmacy_stock() : Met à jour current_stock après transaction
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const pharmacyItemSchema = z.object({
  drugId: z.string().uuid("Invalid drug ID"),
  currentStock: z.number().int().min(0).optional().default(0),
  minStockLevel: z.number().int().min(0).optional(),
  maxStockLevel: z.number().int().min(0).optional(),
  unitCost: z.number().nonnegative().optional(),
  location: z.string().optional(),
});

const transactionSchema = z.object({
  itemId: z.string().uuid("Invalid item ID"),
  transactionType: z.enum(["in", "out"], {
    errorMap: () => ({ message: "Type must be 'in' or 'out'" }),
  }),
  quantity: z.number().int().positive("Quantity must be positive"),
  reason: z.string().optional(),
  reference: z.string().optional(), // Référence commande ou prescription
});

const listSchema = z.object({
  centerId: z.string().uuid().optional(),
  drugId: z.string().uuid().optional(),
  lowStock: z.boolean().optional(), // Filtre items avec stock bas
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

// ============================================================================
// PHARMACY ITEMS ROUTER
// ============================================================================

export const pharmacyItemsRouter = router({
  /**
   * 📋 GET /api/pharmacy-items/list
   * 
   * Liste des items de pharmacie.
   * Filtrés par centre si centerId fourni.
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

      const centerId = input.centerId || ctx.user.centerId;

      if (!centerId && !ctx.user.isSuperadmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Must specify center or be superadmin",
        });
      }

      console.log(`[PharmacyItems] Listing items for center: ${centerId || "ALL"}`);

      let query = database
        .select()
        .from(schema.pharmacyItems)
        .limit(input.limit)
        .offset(input.offset);

      const conditions = [];
      if (centerId) {
        conditions.push(sql`center_id = ${centerId}`);
      }
      if (input.drugId) {
        conditions.push(sql`drug_id = ${input.drugId}`);
      }

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      const items = await query;

      // Filtrer par stock bas si demandé
      let filtered = items;
      if (input.lowStock) {
        // Stock bas = current_stock < min_stock_level (si défini)
        filtered = items.filter((item) => {
          const minLevel = parseInt(item.minStockLevel?.toString() || "0");
          const currentStock = parseInt(item.currentStock?.toString() || "0");
          return minLevel > 0 && currentStock < minLevel;
        });
      }

      console.log(`[PharmacyItems] ✅ Found ${filtered.length} items`);

      return filtered;
    }),

  /**
   * 👤 GET /api/pharmacy-items/:id
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

      console.log(`[PharmacyItems] Getting item: ${input.id}`);

      const item = await database
        .select()
        .from(schema.pharmacyItems)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!item || item.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pharmacy item not found",
        });
      }

      // Récupérer les infos du drug
      const drug = await database
        .select()
        .from(schema.drugs)
        .where(sql`id = ${item[0].drugId}`)
        .limit(1);

      console.log(`[PharmacyItems] ✅ Item retrieved`);

      return {
        ...item[0],
        drug: drug[0] || null,
      };
    }),

  /**
   * ➕ POST /api/pharmacy-items
   * 
   * Crée un nouvel item de pharmacie.
   */
  create: protectedProcedure
    .input(pharmacyItemSchema)
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[PharmacyItems] Creating item for drug: ${input.drugId}`);

      // Vérifier que l'utilisateur a un centre
      if (!ctx.user.centerId && !ctx.user.isSuperadmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Must be assigned to a center to create pharmacy items",
        });
      }

      // Vérifier que le drug existe
      const drug = await database
        .select()
        .from(schema.drugs)
        .where(sql`id = ${input.drugId}`)
        .limit(1);

      if (!drug || drug.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Drug not found",
        });
      }

      // Vérifier qu'il n'existe pas déjà un item pour ce drug dans ce centre
      const existing = await database
        .select()
        .from(schema.pharmacyItems)
        .where(
          sql`center_id = ${ctx.user.centerId} AND drug_id = ${input.drugId}`
        )
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Pharmacy item already exists for this drug in this center",
        });
      }

      // Créer l'item
      const item = await database
        .insert(schema.pharmacyItems)
        .values({
          centerId: ctx.user.centerId!,
          drugId: input.drugId,
          currentStock: input.currentStock || 0,
        })
        .returning();

      if (!item || item.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create pharmacy item",
        });
      }

      console.log(`[PharmacyItems] ✅ Item created: ${item[0].id}`);

      return item[0];
    }),

  /**
   * ✏️ PUT /api/pharmacy-items/:id
   * 
   * Met à jour un item de pharmacie.
   * 
   * ⚠️ NE PAS modifier current_stock manuellement !
   * Utiliser createTransaction pour modifier le stock.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: pharmacyItemSchema.partial().omit({ drugId: true, currentStock: true }),
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

      console.log(`[PharmacyItems] Updating item: ${input.id}`);

      // Vérifier que l'item existe
      const existing = await database
        .select()
        .from(schema.pharmacyItems)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!existing || existing.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pharmacy item not found",
        });
      }

      // Mise à jour (sans current_stock)
      const item = await database
        .update(schema.pharmacyItems)
        .set({
          ...input.data,
          updatedAt: new Date(),
        })
        .where(sql`id = ${input.id}`)
        .returning();

      if (!item || item.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update pharmacy item",
        });
      }

      console.log(`[PharmacyItems] ✅ Item updated: ${item[0].id}`);

      return item[0];
    }),

  /**
   * ❌ DELETE /api/pharmacy-items/:id
   * 
   * Supprime un item de pharmacie.
   * Vérifie qu'il n'y a pas de transactions associées.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[PharmacyItems] Deleting item: ${input.id}`);

      // Vérifier qu'il n'y a pas de transactions
      const transactions = await database
        .select()
        .from(schema.pharmacyTransactions)
        .where(sql`item_id = ${input.id}`)
        .limit(1);

      if (transactions.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cannot delete item with existing transactions",
        });
      }

      // Suppression
      await database.delete(schema.pharmacyItems).where(sql`id = ${input.id}`);

      console.log(`[PharmacyItems] ✅ Item deleted: ${input.id}`);

      return { success: true };
    }),

  /**
   * 📊 GET /api/pharmacy-items/:id/stock
   * 
   * Stock actuel d'un item.
   */
  getStock: protectedProcedure
    .input(z.object({ itemId: z.string().uuid() }))
    .query(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[PharmacyItems] Getting stock for item: ${input.itemId}`);

      const item = await database
        .select()
        .from(schema.pharmacyItems)
        .where(sql`id = ${input.itemId}`)
        .limit(1);

      if (!item || item.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Item not found",
        });
      }

      console.log(`[PharmacyItems] ✅ Stock: ${item[0].currentStock}`);

      return {
        itemId: input.itemId,
        currentStock: parseInt(item[0].currentStock?.toString() || "0"),
        minStockLevel: parseInt(item[0].minStockLevel?.toString() || "0"),
        maxStockLevel: parseInt(item[0].maxStockLevel?.toString() || "0"),
        isLowStock:
          parseInt(item[0].currentStock?.toString() || "0") <
          parseInt(item[0].minStockLevel?.toString() || "0"),
      };
    }),

  /**
   * 📊 GET /api/pharmacy-items/low-stock
   * 
   * Items avec stock bas.
   */
  lowStock: protectedProcedure
    .input(z.object({ centerId: z.string().uuid().optional() }))
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const centerId = input.centerId || ctx.user.centerId;

      if (!centerId && !ctx.user.isSuperadmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Must specify center or be superadmin",
        });
      }

      console.log(`[PharmacyItems] Getting low stock items for center: ${centerId}`);

      // Items avec current_stock < min_stock_level
      const result = await database.execute(sql`
        SELECT pi.*, d.name as drug_name, d.code as drug_code
        FROM pharmacy_items pi
        JOIN drugs d ON d.id = pi.drug_id
        WHERE pi.center_id = ${centerId}
          AND pi.current_stock < COALESCE(pi.min_stock_level, 0)
        ORDER BY (pi.min_stock_level - pi.current_stock) DESC
      `);

      console.log(`[PharmacyItems] ✅ Found ${result.rows.length} low stock items`);

      return result.rows;
    }),

  /**
   * 📜 GET /api/pharmacy-items/:id/transactions
   * 
   * Historique des transactions d'un item.
   */
  getTransactions: protectedProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional().default(50),
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

      console.log(`[PharmacyItems] Getting transactions for item: ${input.itemId}`);

      const transactions = await database
        .select()
        .from(schema.pharmacyTransactions)
        .where(sql`item_id = ${input.itemId}`)
        .orderBy(sql`created_at DESC`)
        .limit(input.limit);

      console.log(`[PharmacyItems] ✅ Found ${transactions.length} transactions`);

      return transactions;
    }),

  /**
   * ➕ POST /api/pharmacy-items/transaction
   * 
   * Crée une transaction (in/out).
   * 
   * ⚠️ TRIGGER AUTOMATIQUE :
   * Le trigger fn_update_pharmacy_stock() met à jour current_stock automatiquement !
   */
  createTransaction: protectedProcedure
    .input(transactionSchema)
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(
        `[PharmacyItems] Creating ${input.transactionType} transaction for item: ${input.itemId}`
      );

      // Vérifier que l'item existe
      const item = await database
        .select()
        .from(schema.pharmacyItems)
        .where(sql`id = ${input.itemId}`)
        .limit(1);

      if (!item || item.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pharmacy item not found",
        });
      }

      // Vérifier stock suffisant pour sortie
      if (input.transactionType === "out") {
        const currentStock = parseInt(item[0].currentStock?.toString() || "0");
        if (currentStock < input.quantity) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Insufficient stock. Current: ${currentStock}, Requested: ${input.quantity}`,
          });
        }
      }

      // Créer transaction
      // ⚠️ Le trigger fn_update_pharmacy_stock() met à jour current_stock automatiquement
      const transaction = await database
        .insert(schema.pharmacyTransactions)
        .values({
          itemId: input.itemId,
          transactionType: input.transactionType,
          quantity: input.quantity,
        })
        .returning();

      if (!transaction || transaction.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create transaction",
        });
      }

      console.log(
        `[PharmacyItems] ✅ Transaction created, stock updated by trigger`
      );

      // Récupérer l'item mis à jour
      const updatedItem = await database
        .select()
        .from(schema.pharmacyItems)
        .where(sql`id = ${input.itemId}`)
        .limit(1);

      return {
        transaction: transaction[0],
        newStock: parseInt(updatedItem[0].currentStock?.toString() || "0"),
      };
    }),
});