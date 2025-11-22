import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * ============================================================================
 * INVOICES ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des factures compatible TITAN V31.4.
 * 
 * Fonctionnalités :
 * - CRUD invoices avec RLS automatique
 * - CRUD invoice_items avec recalcul automatique des totaux
 * - Génération invoice_number unique par centre
 * - Gestion des paiements
 * 
 * ⚠️ TRIGGERS POSTGRESQL AUTOMATIQUES :
 * 
 * 1. trg_invoice_recalc (CRITIQUE) :
 *    - Se déclenche sur INSERT/UPDATE/DELETE de invoice_items
 *    - Recalcule automatiquement invoices.total_amount
 *    - ❌ NE PAS recalculer manuellement côté backend !
 * 
 * 2. Colonne GENERATED :
 *    - invoice_items.total_price = quantity * unit_price
 *    - ❌ NE PAS mapper dans le modèle TypeScript !
 * 
 * Contrainte PostgreSQL active :
 * - invoices_invoice_number_idx : UNIQUE(center_id, invoice_number)
 */

// ============================================================================
// SCHEMAS DE VALIDATION
// ============================================================================

const invoiceSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  invoiceNumber: z.string().optional(), // Généré auto si non fourni
  status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
});

const invoiceItemSchema = z.object({
  invoiceId: z.string().uuid("Invalid invoice ID"),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unitPrice: z.number().nonnegative("Unit price cannot be negative"),
});

const paymentSchema = z.object({
  invoiceId: z.string().uuid("Invalid invoice ID"),
  amount: z.number().positive("Amount must be positive"),
});

const listSchema = z.object({
  patientId: z.string().uuid().optional(),
  status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

// ============================================================================
// INVOICES ROUTER
// ============================================================================

export const invoicesRouter = router({
  /**
   * 📋 GET /api/invoices/list
   * 
   * Liste des factures avec filtres.
   * Filtrée automatiquement par center_id (RLS).
   * 
   * @input { patientId?, status?, limit?, offset? }
   * @returns Liste des factures
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
        `[Invoices] Listing invoices for center: ${ctx.user.centerId || "ALL"}`
      );

      // Construire la requête avec filtres
      let query = database
        .select()
        .from(schema.invoices)
        .limit(input.limit)
        .offset(input.offset);

      // Filtres optionnels
      const conditions = [];
      if (input.patientId) {
        conditions.push(sql`patient_id = ${input.patientId}`);
      }
      if (input.status) {
        conditions.push(sql`status = ${input.status}`);
      }

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      const invoices = await query;

      console.log(`[Invoices] ✅ Found ${invoices.length} invoices`);

      return invoices;
    }),

  /**
   * 👤 GET /api/invoices/:id
   * 
   * Récupère une facture par ID avec ses items.
   * Filtré automatiquement par RLS.
   * 
   * @input { id: UUID }
   * @returns Invoice complète avec items
   * @throws NOT_FOUND si invoice introuvable ou hors centre
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Invoices] Getting invoice: ${input.id}`);

      const invoice = await db.getInvoiceById(input.id);

      if (!invoice) {
        console.error(`[Invoices] Invoice not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }

      // Récupérer les items
      const items = await db.getInvoiceItems(input.id);

      console.log(
        `[Invoices] ✅ Invoice retrieved with ${items.length} items, ` +
        `total: ${invoice.totalAmount}`
      );

      return {
        ...invoice,
        items,
      };
    }),

  /**
   * ➕ POST /api/invoices
   * 
   * Crée une nouvelle facture.
   * Génère automatiquement invoice_number si non fourni.
   * 
   * Workflow :
   * 1. Validation données
   * 2. Génération invoice_number unique
   * 3. Insertion avec center_id du user (RLS)
   * 4. total_amount = 0 (sera calculé par trigger lors de l'ajout d'items)
   * 
   * @input InvoiceSchema
   * @returns Invoice créée
   * @throws CONFLICT si invoice_number existe déjà
   * @throws FORBIDDEN si user sans centre
   */
  create: protectedProcedure
    .input(invoiceSchema)
    .mutation(async ({ input, ctx }) => {
      console.log(`[Invoices] Creating invoice for patient: ${input.patientId}`);

      // Vérifier que l'utilisateur a un centre
      if (!ctx.user.centerId && !ctx.user.isSuperadmin) {
        console.error(`[Invoices] User ${ctx.user.username} has no center`);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You must be assigned to a center to create invoices",
        });
      }

      // Vérifier que le patient existe et appartient au même centre
      const patient = await db.getPatientById(input.patientId);
      if (!patient) {
        console.error(`[Invoices] Patient not found: ${input.patientId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found or not in your center",
        });
      }

      // Générer invoice_number si non fourni
      let invoiceNumber = input.invoiceNumber;
      if (!invoiceNumber) {
        // Format: INV-2025-000123
        const year = new Date().getFullYear();
        const timestamp = Date.now().toString().slice(-6);
        invoiceNumber = `INV-${year}-${timestamp}`;
      }

      try {
        // Créer la facture
        // ⚠️ total_amount = 0 par défaut, sera calculé par trigger
        const invoice = await db.createInvoice({
          patientId: input.patientId,
          centerId: ctx.user.centerId!,
          invoiceNumber,
          status: input.status || "pending",
        });

        if (!invoice) {
          console.error("[Invoices] Failed to create invoice");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create invoice",
          });
        }

        console.log(
          `[Invoices] ✅ Invoice created: ${invoice.invoiceNumber}, ` +
          `total: ${invoice.totalAmount} (will be updated by trigger)`
        );

        return invoice;
      } catch (error: any) {
        // Gérer l'erreur de duplication invoice_number
        if (error.code === "23505" || error.message?.includes("invoices_invoice_number_idx")) {
          console.error(
            `[Invoices] Duplicate invoice number: ${invoiceNumber}`
          );
          throw new TRPCError({
            code: "CONFLICT",
            message: `Invoice number ${invoiceNumber} already exists in this center`,
          });
        }

        console.error("[Invoices] Error creating invoice:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create invoice",
        });
      }
    }),

  /**
   * ✏️ PUT /api/invoices/:id
   * 
   * Met à jour une facture.
   * 
   * ⚠️ NE PAS modifier total_amount manuellement !
   * Le trigger recalc_invoice_totals() le fait automatiquement.
   * 
   * @input { id, data: { status? } }
   * @returns Invoice mise à jour
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: z.object({
          status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Invoices] Updating invoice: ${input.id}`);

      // Vérifier que la facture existe
      const existing = await db.getInvoiceById(input.id);
      if (!existing) {
        console.error(`[Invoices] Invoice not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }

      // Mise à jour (seulement status autorisé)
      const invoice = await db.updateInvoice(input.id, {
        status: input.data.status,
      });

      if (!invoice) {
        console.error(`[Invoices] Failed to update: ${input.id}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update invoice",
        });
      }

      console.log(`[Invoices] ✅ Invoice updated: ${invoice.invoiceNumber}`);

      return invoice;
    }),

  /**
   * ➕ POST /api/invoices/:id/items
   * 
   * Ajoute un item à une facture.
   * 
   * ⚠️ TRIGGER AUTOMATIQUE :
   * Après l'insertion, le trigger trg_invoice_recalc()
   * recalcule automatiquement invoices.total_amount.
   * 
   * Workflow :
   * 1. Vérifier que la facture existe
   * 2. Insérer l'item (total_price calculé par GENERATED column)
   * 3. Le trigger met à jour invoices.total_amount automatiquement
   * 
   * @input InvoiceItemSchema
   * @returns Item créé + facture mise à jour
   */
  addItem: protectedProcedure
    .input(invoiceItemSchema)
    .mutation(async ({ input }) => {
      console.log(`[Invoices] Adding item to invoice: ${input.invoiceId}`);

      // Vérifier que la facture existe
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) {
        console.error(`[Invoices] Invoice not found: ${input.invoiceId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }

      // ❌ NE PAS calculer total_price manuellement !
      // La colonne GENERATED le fait automatiquement
      const item = await db.createInvoiceItem({
        invoiceId: input.invoiceId,
        description: input.description,
        quantity: input.quantity.toString(),
        unitPrice: input.unitPrice.toString(),
      });

      if (!item) {
        console.error("[Invoices] Failed to create item");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create invoice item",
        });
      }

      console.log(
        `[Invoices] ✅ Item added: ${item.description}, ` +
        `qty: ${item.quantity}, price: ${item.unitPrice}`
      );

      // ⚠️ IMPORTANT : Récupérer la facture mise à jour
      // Le trigger a recalculé total_amount !
      const updatedInvoice = await db.getInvoiceById(input.invoiceId);

      console.log(
        `[Invoices] ✅ Invoice total updated by trigger: ` +
        `${invoice.totalAmount} → ${updatedInvoice?.totalAmount}`
      );

      return {
        item,
        invoice: updatedInvoice,
      };
    }),

  /**
   * 📋 GET /api/invoices/:id/items
   * 
   * Liste des items d'une facture.
   * 
   * @input { invoiceId: UUID }
   * @returns Liste des items
   */
  getItems: protectedProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .query(async ({ input }) => {
      console.log(`[Invoices] Getting items for invoice: ${input.invoiceId}`);

      // Vérifier que la facture existe (RLS filtre automatiquement)
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) {
        console.error(`[Invoices] Invoice not found: ${input.invoiceId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }

      const items = await db.getInvoiceItems(input.invoiceId);

      console.log(`[Invoices] ✅ Found ${items.length} items`);

      return items;
    }),

  /**
   * 💰 POST /api/invoices/:id/payments
   * 
   * Enregistre un paiement pour une facture.
   * 
   * Workflow :
   * 1. Créer le payment
   * 2. Mettre à jour invoices.paid_amount
   * 3. Si paid_amount >= total_amount, status = 'paid'
   * 
   * @input { invoiceId, amount }
   * @returns Payment créé + facture mise à jour
   */
  addPayment: protectedProcedure
    .input(paymentSchema)
    .mutation(async ({ input }) => {
      console.log(`[Invoices] Adding payment to invoice: ${input.invoiceId}`);

      // Vérifier que la facture existe
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) {
        console.error(`[Invoices] Invoice not found: ${input.invoiceId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }

      // Vérifier que le montant ne dépasse pas le reste à payer
      const totalAmount = parseFloat(invoice.totalAmount?.toString() || "0");
      const paidAmount = parseFloat(invoice.paidAmount?.toString() || "0");
      const remaining = totalAmount - paidAmount;

      if (input.amount > remaining) {
        console.error(
          `[Invoices] Payment amount ${input.amount} exceeds remaining ${remaining}`
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Payment amount exceeds remaining balance (${remaining})`,
        });
      }

      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      // Créer le payment
      const payment = await database
        .insert(schema.payments)
        .values({
          invoiceId: input.invoiceId,
          patientId: invoice.patientId,
          amount: input.amount.toString(),
        })
        .returning();

      if (!payment || payment.length === 0) {
        console.error("[Invoices] Failed to create payment");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create payment",
        });
      }

      // Mettre à jour paid_amount
      const newPaidAmount = paidAmount + input.amount;
      const newStatus = newPaidAmount >= totalAmount ? "paid" : invoice.status;

      await db.updateInvoice(input.invoiceId, {
        paidAmount: newPaidAmount.toString(),
        status: newStatus,
      });

      console.log(
        `[Invoices] ✅ Payment recorded: ${input.amount}, ` +
        `new paid_amount: ${newPaidAmount}, status: ${newStatus}`
      );

      // Récupérer la facture mise à jour
      const updatedInvoice = await db.getInvoiceById(input.invoiceId);

      return {
        payment: payment[0],
        invoice: updatedInvoice,
      };
    }),

  /**
   * 📊 GET /api/invoices/summary
   * 
   * Statistiques des factures du centre.
   * Utilise la vue v_invoice_summary si disponible.
   * 
   * @returns Résumé par statut
   */
  summary: protectedProcedure.query(async ({ ctx }) => {
    const database = await getDb();
    if (!database) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
      });
    }

    console.log(`[Invoices] Getting summary for center: ${ctx.user.centerId || "ALL"}`);

    // Utiliser la vue PostgreSQL
    const result = await database.execute(sql`
      SELECT * FROM v_invoice_summary
    `);

    const summary = result.rows;

    console.log(`[Invoices] ✅ Summary retrieved`);

    return summary;
  }),
});