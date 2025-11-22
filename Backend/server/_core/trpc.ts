import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { setRLSContext } from "../db/rls";

/**
 * ============================================================================
 * TRPC CONFIGURATION WITH RLS MIDDLEWARE
 * ============================================================================
 * 
 * Configuration tRPC avec middleware RLS intégré.
 * Compatible avec le schéma TITAN V31.4 GOLD MASTER.
 * 
 * Middlewares disponibles :
 * - requireUser : Vérifie authentification + applique RLS
 * - requireAdmin : Vérifie is_superadmin = true
 * 
 * Toutes les procédures protégées appliquent automatiquement
 * le contexte RLS PostgreSQL via SET app.user_id et SET app.center_id.
 */

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * ⚠️ MIDDLEWARE CRITIQUE : Authentification + RLS
 * 
 * Ce middleware :
 * 1. Vérifie que l'utilisateur est connecté (ctx.user existe)
 * 2. Applique le contexte RLS PostgreSQL AVANT chaque requête
 * 3. Propage ctx.user dans le contexte tRPC
 * 
 * ✅ Toutes les requêtes DB suivantes seront automatiquement filtrées
 *    par center_id grâce aux politiques RLS PostgreSQL.
 * 
 * Politiques RLS actives :
 * - users: is_superadmin = TRUE OR center_id = get_user_center_id()
 * - patients: center_id = get_user_center_id()
 * - appointments: center_id = get_user_center_id()
 * - invoices: center_id = get_user_center_id()
 * - documents: center_id = get_user_center_id()
 * - medical_acts: (SELECT center_id FROM encounters WHERE id = encounter_id) = get_user_center_id()
 * - prescriptions: (SELECT center_id FROM encounters WHERE id = encounter_id) = get_user_center_id()
 */
const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  // 1. Vérifier que l'utilisateur est connecté
  if (!ctx.user) {
    console.error("[tRPC] Unauthorized access attempt");
    throw new TRPCError({ 
      code: "UNAUTHORIZED", 
      message: UNAUTHED_ERR_MSG 
    });
  }

  try {
    // 2. Appliquer le contexte RLS PostgreSQL
    // ⚠️ CRITIQUE : Cette ligne active l'isolation multi-centres
    await setRLSContext(ctx.user.id, ctx.user.centerId || null);

    console.log(
      `[tRPC] ✅ RLS Context applied - User: ${ctx.user.username}, ` +
      `Center: ${ctx.user.centerId || "NULL (superadmin)"}`
    );
  } catch (error) {
    console.error("[tRPC] Failed to set RLS context:", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to initialize secure context",
    });
  }

  // 3. Continuer avec le contexte utilisateur
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * 🔐 Procédure protégée avec RLS
 * 
 * Toutes les requêtes utilisant cette procédure :
 * - Nécessitent une authentification
 * - Ont le contexte RLS appliqué automatiquement
 * - Sont isolées par centre (sauf superadmin)
 * 
 * @example
 * const myRouter = router({
 *   getPatients: protectedProcedure
 *     .query(async () => {
 *       // Cette requête est automatiquement filtrée par center_id
 *       return await db.select().from(schema.patients);
 *     })
 * });
 */
export const protectedProcedure = t.procedure.use(requireUser);

/**
 * ⚠️ MIDDLEWARE ADMIN : Vérification superadmin
 * 
 * Ce middleware vérifie que l'utilisateur a is_superadmin = true.
 * Les superadmins peuvent :
 * - Voir tous les centres (RLS bypass via is_superadmin OR center_id)
 * - Modifier les paramètres système
 * - Gérer tous les utilisateurs
 * 
 * Le contexte RLS est quand même appliqué, mais les politiques
 * permettent aux superadmins de bypasser le filtre center_id.
 */
const requireAdmin = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  // 1. Vérifier authentification de base
  if (!ctx.user) {
    console.error("[tRPC] Admin access attempt without authentication");
    throw new TRPCError({ 
      code: "UNAUTHORIZED", 
      message: UNAUTHED_ERR_MSG 
    });
  }

  // 2. Vérifier le statut superadmin
  if (!ctx.user.isSuperadmin) {
    console.error(
      `[tRPC] Admin access denied for user ${ctx.user.username} ` +
      `(is_superadmin: ${ctx.user.isSuperadmin})`
    );
    throw new TRPCError({ 
      code: "FORBIDDEN", 
      message: NOT_ADMIN_ERR_MSG 
    });
  }

  try {
    // 3. Appliquer RLS même pour les admins (avec center_id = NULL)
    // Les politiques RLS permettent aux superadmins de voir tous les centres
    await setRLSContext(ctx.user.id, ctx.user.centerId || null);

    console.log(
      `[tRPC] ✅ Admin access granted - User: ${ctx.user.username}, ` +
      `Superadmin: true`
    );
  } catch (error) {
    console.error("[tRPC] Failed to set admin RLS context:", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to initialize admin context",
    });
  }

  // 4. Continuer avec le contexte admin
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * 👑 Procédure admin (superadmin uniquement)
 * 
 * Utilise cette procédure pour les opérations sensibles :
 * - Gestion des paramètres système (system_settings)
 * - Création/modification des centres
 * - Gestion globale des utilisateurs
 * - Consultation des statistiques globales
 * 
 * @example
 * const adminRouter = router({
 *   updateSystemSettings: adminProcedure
 *     .input(z.object({ key: z.string(), value: z.any() }))
 *     .mutation(async ({ input }) => {
 *       // Seuls les superadmins peuvent modifier system_settings
 *       return await db.updateSystemSetting(input.key, input.value);
 *     })
 * });
 */
export const adminProcedure = t.procedure.use(requireAdmin);

/**
 * 🔍 Middleware de logging (optionnel, pour debug)
 * 
 * Log toutes les requêtes tRPC avec timing.
 * Utile en développement, peut être désactivé en production.
 */
const loggerMiddleware = t.middleware(async (opts) => {
  const { ctx, next, path, type } = opts;
  const start = Date.now();

  const result = await next();

  const duration = Date.now() - start;
  const user = ctx.user?.username || "anonymous";

  console.log(
    `[tRPC] ${type} ${path} - User: ${user} - Duration: ${duration}ms`
  );

  return result;
});

/**
 * 📝 Procédure avec logging (optionnel)
 * 
 * Identique à publicProcedure mais avec logging automatique.
 * Utile pour débugger les performances ou tracer les actions.
 * 
 * @example
 * const debugRouter = router({
 *   slowQuery: loggedProcedure
 *     .query(async () => {
 *       // Le temps d'exécution sera loggé automatiquement
 *       return await heavyDatabaseQuery();
 *     })
 * });
 */
export const loggedProcedure = t.procedure.use(loggerMiddleware);
export const loggedProtectedProcedure = t.procedure
  .use(requireUser)
  .use(loggerMiddleware);

/**
 * 🧪 Utilitaires pour les tests
 */

/**
 * Crée un contexte de test avec utilisateur simulé
 * 
 * @example
 * const ctx = createTestContext({
 *   id: 'test-user-id',
 *   centerId: 'test-center-id',
 *   username: 'testuser',
 *   isSuperadmin: false
 * });
 */
export function createTestContext(user: {
  id: string;
  centerId: string | null;
  username: string;
  email: string;
  fullName: string;
  isSuperadmin: boolean;
}): TrpcContext {
  return {
    user,
    req: {} as any,
    res: {} as any,
  };
}

/**
 * Vérifie si une procédure est protégée (pour les tests)
 * 
 * @example
 * const isProtected = await isProcedureProtected(
 *   myRouter.getPatients,
 *   createTestContext(...)
 * );
 */
export async function isProcedureProtected(
  procedure: any,
  ctx: TrpcContext
): Promise<boolean> {
  try {
    await procedure(ctx);
    return false;
  } catch (error) {
    if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
      return true;
    }
    throw error;
  }
}