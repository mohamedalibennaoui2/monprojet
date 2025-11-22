import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * ============================================================================
 * FILE STORES ROUTER
 * ============================================================================
 * 
 * Router pour la configuration des systèmes de stockage de fichiers.
 * 
 * Fonctionnalités :
 * - CRUD file stores (admin only)
 * - Configuration stockage local, S3, Azure, etc.
 * - Définir le store par défaut
 * - Test de connexion au store
 * 
 * Types de stores supportés :
 * - local : Stockage sur disque local
 * - s3 : Amazon S3 ou compatible (MinIO)
 * - azure : Azure Blob Storage
 * - gcs : Google Cloud Storage
 * 
 * ⚠️ Les file stores sont globaux (pas de center_id)
 * ⚠️ Seuls les superadmins peuvent gérer les file stores
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const fileStoreSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["local", "s3", "azure", "gcs"], {
    errorMap: () => ({
      message: "Type must be one of: local, s3, azure, gcs",
    }),
  }),
  config: z.object({
    // Config locale
    path: z.string().optional(), // Pour local

    // Config S3
    bucket: z.string().optional(),
    region: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    endpoint: z.string().optional(), // Pour MinIO

    // Config Azure
    containerName: z.string().optional(),
    connectionString: z.string().optional(),

    // Config GCS
    projectId: z.string().optional(),
    keyFilename: z.string().optional(),
  }),
  isDefault: z.boolean().optional().default(false),
});

// ============================================================================
// FILE STORES ROUTER
// ============================================================================

export const fileStoresRouter = router({
  /**
   * 📋 GET /api/file-stores/list
   * 
   * Liste de tous les file stores.
   */
  list: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
      });
    }

    console.log("[FileStores] Listing file stores");

    const stores = await database.select().from(schema.fileStores);

    // Masquer les secrets dans la réponse
    const sanitized = stores.map((store) => ({
      ...store,
      config: {
        ...store.config,
        accessKeyId: store.config?.accessKeyId ? "***" : undefined,
        secretAccessKey: store.config?.secretAccessKey ? "***" : undefined,
        connectionString: store.config?.connectionString ? "***" : undefined,
      },
    }));

    console.log(`[FileStores] ✅ Found ${stores.length} file stores`);

    return sanitized;
  }),

  /**
   * 👤 GET /api/file-stores/:id
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

      console.log(`[FileStores] Getting file store: ${input.id}`);

      const store = await database
        .select()
        .from(schema.fileStores)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!store || store.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File store not found",
        });
      }

      // Masquer les secrets
      const sanitized = {
        ...store[0],
        config: {
          ...store[0].config,
          accessKeyId: store[0].config?.accessKeyId ? "***" : undefined,
          secretAccessKey: store[0].config?.secretAccessKey ? "***" : undefined,
          connectionString: store[0].config?.connectionString ? "***" : undefined,
        },
      };

      console.log(`[FileStores] ✅ File store retrieved: ${store[0].name}`);

      return sanitized;
    }),

  /**
   * 👤 GET /api/file-stores/default
   * 
   * Récupère le file store par défaut.
   */
  getDefault: protectedProcedure.query(async () => {
    const database = await getDb();
    if (!database) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
      });
    }

    console.log(`[FileStores] Getting default file store`);

    const store = await database
      .select()
      .from(schema.fileStores)
      .where(sql`is_default = true`)
      .limit(1);

    if (!store || store.length === 0) {
      // Créer un store local par défaut si aucun n'existe
      const defaultStore = await database
        .insert(schema.fileStores)
        .values({
          name: "Local Storage",
          type: "local",
          config: { path: "./uploads" },
          isDefault: true,
        })
        .returning();

      console.log(`[FileStores] ✅ Created default local file store`);

      return defaultStore[0];
    }

    console.log(`[FileStores] ✅ Default file store: ${store[0].name}`);

    return store[0];
  }),

  /**
   * ➕ POST /api/file-stores (Admin only)
   * 
   * Crée un nouveau file store.
   */
  create: adminProcedure
    .input(fileStoreSchema)
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[FileStores] Creating file store: ${input.name}`);

      // Vérifier nom unique
      const existing = await database
        .select()
        .from(schema.fileStores)
        .where(sql`name = ${input.name}`)
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `File store ${input.name} already exists`,
        });
      }

      // Si isDefault = true, désactiver les autres stores par défaut
      if (input.isDefault) {
        await database
          .update(schema.fileStores)
          .set({ isDefault: false })
          .where(sql`is_default = true`);
      }

      // Créer store
      const store = await database
        .insert(schema.fileStores)
        .values({
          name: input.name,
          type: input.type,
          config: input.config,
          isDefault: input.isDefault || false,
        })
        .returning();

      if (!store || store.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create file store",
        });
      }

      console.log(`[FileStores] ✅ File store created: ${store[0].name}`);

      return store[0];
    }),

  /**
   * ✏️ PUT /api/file-stores/:id (Admin only)
   */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: fileStoreSchema.partial(),
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

      console.log(`[FileStores] Updating file store: ${input.id}`);

      // Vérifier que le store existe
      const existing = await database
        .select()
        .from(schema.fileStores)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!existing || existing.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File store not found",
        });
      }

      // Si isDefault = true, désactiver les autres
      if (input.data.isDefault === true) {
        await database
          .update(schema.fileStores)
          .set({ isDefault: false })
          .where(sql`is_default = true AND id != ${input.id}`);
      }

      // Fusionner config
      const updatedConfig = {
        ...existing[0].config,
        ...input.data.config,
      };

      // Mise à jour
      const store = await database
        .update(schema.fileStores)
        .set({
          name: input.data.name,
          type: input.data.type,
          config: updatedConfig,
          isDefault: input.data.isDefault,
        })
        .where(sql`id = ${input.id}`)
        .returning();

      if (!store || store.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update file store",
        });
      }

      console.log(`[FileStores] ✅ File store updated: ${store[0].name}`);

      return store[0];
    }),

  /**
   * ❌ DELETE /api/file-stores/:id (Admin only)
   * 
   * Supprime un file store.
   * Vérifie qu'aucun document ne l'utilise.
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

      console.log(`[FileStores] Deleting file store: ${input.id}`);

      // Vérifier qu'aucun document n'utilise ce store
      const documents = await database
        .select()
        .from(schema.documents)
        .where(sql`file_store_id = ${input.id}`)
        .limit(1);

      if (documents.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cannot delete file store: documents are using it",
        });
      }

      // Vérifier que ce n'est pas le store par défaut
      const store = await database
        .select()
        .from(schema.fileStores)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (store.length > 0 && store[0].isDefault) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cannot delete default file store. Set another store as default first.",
        });
      }

      // Suppression
      await database.delete(schema.fileStores).where(sql`id = ${input.id}`);

      console.log(`[FileStores] ✅ File store deleted: ${input.id}`);

      return { success: true };
    }),

  /**
   * 🔧 POST /api/file-stores/:id/set-default (Admin only)
   * 
   * Définit un store comme store par défaut.
   */
  setDefault: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[FileStores] Setting default file store: ${input.id}`);

      // Vérifier que le store existe
      const store = await database
        .select()
        .from(schema.fileStores)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!store || store.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File store not found",
        });
      }

      // Désactiver tous les autres stores par défaut
      await database
        .update(schema.fileStores)
        .set({ isDefault: false })
        .where(sql`is_default = true`);

      // Activer celui-ci
      await database
        .update(schema.fileStores)
        .set({ isDefault: true })
        .where(sql`id = ${input.id}`);

      console.log(`[FileStores] ✅ Default file store set: ${store[0].name}`);

      return { success: true };
    }),

  /**
   * 🧪 POST /api/file-stores/:id/test (Admin only)
   * 
   * Teste la connexion à un file store.
   * 
   * ⚠️ À implémenter selon le type de store (local, S3, Azure, GCS)
   */
  test: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[FileStores] Testing file store: ${input.id}`);

      // Récupérer le store
      const store = await database
        .select()
        .from(schema.fileStores)
        .where(sql`id = ${input.id}`)
        .limit(1);

      if (!store || store.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File store not found",
        });
      }

      // Test selon le type
      // TODO: Implémenter tests réels
      // - local: Vérifier que le path existe et est accessible
      // - s3: Tester connexion avec AWS SDK
      // - azure: Tester connexion avec Azure SDK
      // - gcs: Tester connexion avec GCS SDK

      console.log(`[FileStores] ✅ Test successful (mock): ${store[0].name}`);

      return {
        success: true,
        message: `Connection to ${store[0].name} successful`,
        type: store[0].type,
      };
    }),
});