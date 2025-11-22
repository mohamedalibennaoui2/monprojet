import { sql } from "drizzle-orm";
import { getDb } from "../db";

/**
 * ============================================================================
 * ROW LEVEL SECURITY (RLS) CONTEXT MANAGEMENT
 * ============================================================================
 * 
 * Ce module gère le contexte RLS PostgreSQL pour l'isolation multi-centres.
 * Compatible avec le schéma TITAN V31.4 GOLD MASTER.
 * 
 * Fonctions PostgreSQL utilisées :
 * - get_user_center_id() : Récupère center_id depuis app.center_id
 * - get_current_user_id() : Récupère user_id depuis app.user_id
 * 
 * Politiques RLS actives sur :
 * - users, patients, appointments, invoices, documents, medical_acts, prescriptions
 */

/**
 * ⚠️ FONCTION CRITIQUE : Applique le contexte RLS PostgreSQL
 * 
 * DOIT être appelée au début de chaque requête protégée.
 * Les politiques RLS PostgreSQL filtreront automatiquement les données
 * selon center_id et user_id définis ici.
 * 
 * @param userId - UUID de l'utilisateur connecté
 * @param centerId - UUID du centre (null pour superadmin)
 * 
 * @example
 * await setRLSContext(user.id, user.centerId);
 * // Maintenant toutes les requêtes sont filtrées par centre
 */
export async function setRLSContext(
  userId: string,
  centerId: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("[RLS] Database not available");
  }

  try {
    // Définir les variables de session PostgreSQL
    await db.execute(sql.raw(`SET app.user_id = '${userId}'`));

    if (centerId) {
      await db.execute(sql.raw(`SET app.center_id = '${centerId}'`));
    } else {
      // Pour les superadmins sans centre (is_superadmin = true)
      // RLS policy permet : is_superadmin = TRUE OR center_id = get_user_center_id()
      await db.execute(sql.raw(`SET app.center_id = NULL`));
    }

    console.log(`[RLS] Context set - User: ${userId}, Center: ${centerId || "NULL (superadmin)"}`);
  } catch (error) {
    console.error("[RLS] Failed to set context:", error);
    throw new Error("Failed to apply RLS context");
  }
}

/**
 * Réinitialise le contexte RLS
 * 
 * Utile pour le pooling de connexions ou les tests.
 * En production, chaque requête devrait avoir son propre contexte.
 */
export async function resetRLSContext(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db.execute(sql`RESET app.user_id`);
    await db.execute(sql`RESET app.center_id`);
    console.log("[RLS] Context reset");
  } catch (error) {
    console.warn("[RLS] Failed to reset context:", error);
  }
}

/**
 * Wrapper pour exécuter une fonction avec contexte RLS
 * 
 * Applique automatiquement le contexte RLS avant l'exécution
 * et le réinitialise après (optionnel).
 * 
 * @param userId - UUID de l'utilisateur
 * @param centerId - UUID du centre (null pour superadmin)
 * @param fn - Fonction async à exécuter avec RLS
 * @param resetAfter - Si true, réinitialise le contexte après exécution
 * 
 * @example
 * const patients = await withRLSContext(
 *   user.id,
 *   user.centerId,
 *   async () => {
 *     return await db.select().from(schema.patients);
 *   }
 * );
 */
export async function withRLSContext<T>(
  userId: string,
  centerId: string | null,
  fn: () => Promise<T>,
  resetAfter: boolean = false
): Promise<T> {
  await setRLSContext(userId, centerId);

  try {
    return await fn();
  } finally {
    if (resetAfter) {
      await resetRLSContext();
    }
  }
}

/**
 * Récupère le contexte RLS actuel (pour debug)
 * 
 * @returns Objet avec userId et centerId actuels ou null si non définis
 */
export async function getCurrentRLSContext(): Promise<{
  userId: string | null;
  centerId: string | null;
} | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db.execute(sql`
      SELECT 
        current_setting('app.user_id', true) as user_id,
        current_setting('app.center_id', true) as center_id
    `);

    const row = result.rows[0] as any;
    return {
      userId: row?.user_id || null,
      centerId: row?.center_id || null,
    };
  } catch (error) {
    console.error("[RLS] Failed to get current context:", error);
    return null;
  }
}

/**
 * Vérifie si le contexte RLS est correctement configuré
 * 
 * @throws Error si le contexte n'est pas défini
 */
export async function validateRLSContext(): Promise<void> {
  const context = await getCurrentRLSContext();

  if (!context || !context.userId) {
    throw new Error(
      "[RLS] Context not set. Call setRLSContext() before database operations."
    );
  }

  console.log("[RLS] Context validated:", context);
}

/**
 * Teste l'isolation RLS entre deux utilisateurs
 * 
 * Fonction utilitaire pour les tests uniquement.
 * 
 * @example
 * await testRLSIsolation(
 *   { id: 'user1', centerId: 'center1' },
 *   { id: 'user2', centerId: 'center2' }
 * );
 */
export async function testRLSIsolation(
  user1: { id: string; centerId: string },
  user2: { id: string; centerId: string }
): Promise<{
  user1Count: number;
  user2Count: number;
  isolated: boolean;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Context user 1
  await setRLSContext(user1.id, user1.centerId);
  const result1 = await db.execute(sql`SELECT COUNT(*) as count FROM patients`);
  const user1Count = parseInt((result1.rows[0] as any)?.count || "0");

  // Context user 2
  await setRLSContext(user2.id, user2.centerId);
  const result2 = await db.execute(sql`SELECT COUNT(*) as count FROM patients`);
  const user2Count = parseInt((result2.rows[0] as any)?.count || "0");

  await resetRLSContext();

  return {
    user1Count,
    user2Count,
    isolated: user1Count !== user2Count || user1Count === 0,
  };
}