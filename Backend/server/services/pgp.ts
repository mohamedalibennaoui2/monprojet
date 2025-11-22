import { sql } from "drizzle-orm";
import { getDb } from "../db";

/**
 * ============================================================================
 * PGP ENCRYPTION SERVICE
 * ============================================================================
 * 
 * Service de chiffrement/déchiffrement PGP utilisant les fonctions PostgreSQL.
 * Compatible avec le schéma TITAN V31.4 GOLD MASTER.
 * 
 * Fonctions PostgreSQL utilisées :
 * - app_get_encryption_key() : Récupère la clé depuis system_settings
 * - encrypt_pgp_data(text) : Chiffre avec pgp_sym_encrypt
 * - decrypt_pgp_data(bytea) : Déchiffre avec pgp_sym_decrypt
 * 
 * Champs chiffrés dans le schéma :
 * - appointments.notes_encrypted (BYTEA)
 * - encounters.plan_encrypted (BYTEA)
 */

export class PGPService {
  /**
   * 🔑 Récupère la clé de chiffrement depuis system_settings
   * 
   * La clé est stockée dans la table system_settings avec key='encryption'.
   * ⚠️ Cette clé DOIT être changée en production !
   * 
   * @returns Clé de chiffrement
   * @throws Error si la clé n'existe pas
   */
  private static async getEncryptionKey(): Promise<string> {
    const db = await getDb();
    if (!db) {
      throw new Error("[PGP] Database not available");
    }

    try {
      const result = await db.execute(sql`
        SELECT value->>'encryption_key' as key
        FROM system_settings
        WHERE key = 'encryption'
        LIMIT 1
      `);

      const key = (result.rows[0] as any)?.key;

      if (!key) {
        throw new Error(
          "[PGP] Encryption key not found in system_settings. Run migrations first."
        );
      }

      // Avertissement si clé par défaut
      if (key === "CHANGE_THIS_KEY_IMMEDIATELY_IN_PROD") {
        console.warn(
          "⚠️  [PGP] WARNING: Using default encryption key! Change it in production!"
        );
      }

      return key;
    } catch (error) {
      console.error("[PGP] Failed to retrieve encryption key:", error);
      throw new Error("Cannot retrieve encryption key");
    }
  }

  /**
   * 🔒 Chiffre une chaîne de caractères avec pgp_sym_encrypt
   * 
   * Utilise la fonction PostgreSQL encrypt_pgp_data() qui appelle
   * pgp_sym_encrypt() avec la clé récupérée depuis system_settings.
   * 
   * @param plaintext - Texte en clair à chiffrer
   * @returns Buffer BYTEA chiffré
   * @throws Error si le chiffrement échoue
   * 
   * @example
   * const encrypted = await PGPService.encrypt("Notes confidentielles");
   * // encrypted est un Buffer BYTEA prêt pour la DB
   */
  static async encrypt(plaintext: string): Promise<Buffer> {
    const db = await getDb();
    if (!db) {
      throw new Error("[PGP] Database not available");
    }

    if (!plaintext || plaintext.trim().length === 0) {
      throw new Error("[PGP] Cannot encrypt empty string");
    }

    try {
      console.log(`[PGP] Encrypting ${plaintext.length} characters...`);

      const result = await db.execute(sql`
        SELECT encrypt_pgp_data(${plaintext}) as encrypted
      `);

      const encrypted = (result.rows[0] as any)?.encrypted;

      if (!encrypted) {
        throw new Error("Encryption returned null");
      }

      console.log("[PGP] ✅ Encryption successful");

      // Drizzle avec postgres-js retourne déjà un Buffer pour BYTEA
      return Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    } catch (error) {
      console.error("[PGP] Encryption failed:", error);
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * 🔓 Déchiffre un Buffer BYTEA avec pgp_sym_decrypt
   * 
   * Utilise la fonction PostgreSQL decrypt_pgp_data() qui appelle
   * pgp_sym_decrypt() avec la clé récupérée depuis system_settings.
   * 
   * @param ciphertext - Buffer BYTEA chiffré depuis la DB
   * @returns Texte en clair déchiffré
   * @throws Error si le déchiffrement échoue
   * 
   * @example
   * const decrypted = await PGPService.decrypt(appointment.notesEncrypted);
   * // decrypted est le texte en clair
   */
  static async decrypt(ciphertext: Buffer): Promise<string> {
    const db = await getDb();
    if (!db) {
      throw new Error("[PGP] Database not available");
    }

    if (!ciphertext || ciphertext.length === 0) {
      throw new Error("[PGP] Cannot decrypt empty buffer");
    }

    try {
      console.log(`[PGP] Decrypting ${ciphertext.length} bytes...`);

      // PostgreSQL attend un BYTEA, que Drizzle encode correctement
      const result = await db.execute(sql`
        SELECT decrypt_pgp_data(${ciphertext}::bytea) as decrypted
      `);

      const decrypted = (result.rows[0] as any)?.decrypted;

      if (decrypted === undefined || decrypted === null) {
        throw new Error("Decryption returned null - invalid ciphertext or wrong key");
      }

      console.log("[PGP] ✅ Decryption successful");

      return decrypted;
    } catch (error) {
      console.error("[PGP] Decryption failed:", error);
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  /**
   * 🔒 Chiffre seulement si la valeur est non-null/non-vide
   * 
   * Utile pour les champs optionnels.
   * 
   * @param plaintext - Texte en clair (peut être null/undefined/vide)
   * @returns Buffer chiffré ou null
   * 
   * @example
   * const encrypted = await PGPService.encryptOptional(input.notes);
   * // encrypted est null si input.notes était vide
   */
  static async encryptOptional(
    plaintext: string | null | undefined
  ): Promise<Buffer | null> {
    if (!plaintext || plaintext.trim().length === 0) {
      return null;
    }

    try {
      return await this.encrypt(plaintext);
    } catch (error) {
      console.error("[PGP] Optional encryption failed:", error);
      return null;
    }
  }

  /**
   * 🔓 Déchiffre seulement si la valeur est non-null
   * 
   * Utile pour les champs optionnels.
   * 
   * @param ciphertext - Buffer chiffré (peut être null/undefined)
   * @returns Texte déchiffré ou null
   * 
   * @example
   * const decrypted = await PGPService.decryptOptional(appointment.notesEncrypted);
   * // decrypted est null si notesEncrypted était null
   */
  static async decryptOptional(
    ciphertext: Buffer | null | undefined
  ): Promise<string | null> {
    if (!ciphertext || ciphertext.length === 0) {
      return null;
    }

    try {
      return await this.decrypt(ciphertext);
    } catch (error) {
      console.error("[PGP] Optional decryption failed:", error);
      return null;
    }
  }

  /**
   * 🔄 Chiffre plusieurs valeurs en parallèle
   * 
   * Optimisé pour chiffrer plusieurs champs en une seule fois.
   * 
   * @param plaintexts - Tableau de textes en clair
   * @returns Tableau de Buffers chiffrés (null pour valeurs vides)
   * 
   * @example
   * const [notes, plan] = await PGPService.encryptBatch([
   *   input.notes,
   *   input.plan
   * ]);
   */
  static async encryptBatch(
    plaintexts: (string | null | undefined)[]
  ): Promise<(Buffer | null)[]> {
    return await Promise.all(
      plaintexts.map((text) => this.encryptOptional(text))
    );
  }

  /**
   * 🔄 Déchiffre plusieurs valeurs en parallèle
   * 
   * Optimisé pour déchiffrer plusieurs champs en une seule fois.
   * 
   * @param ciphertexts - Tableau de Buffers chiffrés
   * @returns Tableau de textes déchiffrés (null pour valeurs vides)
   * 
   * @example
   * const [notes, plan] = await PGPService.decryptBatch([
   *   appointment.notesEncrypted,
   *   encounter.planEncrypted
   * ]);
   */
  static async decryptBatch(
    ciphertexts: (Buffer | null | undefined)[]
  ): Promise<(string | null)[]> {
    return await Promise.all(
      ciphertexts.map((cipher) => this.decryptOptional(cipher))
    );
  }

  /**
   * 🔧 Change la clé de chiffrement dans system_settings
   * 
   * ⚠️ ATTENTION : Changer la clé rendra TOUS les anciens chiffrements illisibles !
   * Utilisez cette fonction uniquement lors de l'installation initiale.
   * 
   * Pour une rotation de clé en production, il faut :
   * 1. Déchiffrer toutes les données avec l'ancienne clé
   * 2. Changer la clé
   * 3. Re-chiffrer toutes les données avec la nouvelle clé
   * 
   * @param newKey - Nouvelle clé de chiffrement (minimum 32 caractères)
   * @throws Error si la clé est trop courte
   */
  static async updateEncryptionKey(newKey: string): Promise<void> {
    const db = await getDb();
    if (!db) {
      throw new Error("[PGP] Database not available");
    }

    if (newKey.length < 32) {
      throw new Error(
        "[PGP] Encryption key must be at least 32 characters long"
      );
    }

    try {
      await db.execute(sql`
        UPDATE system_settings
        SET value = jsonb_set(value, '{encryption_key}', to_jsonb(${newKey}::text))
        WHERE key = 'encryption'
      `);

      console.log("[PGP] ✅ Encryption key updated successfully");
      console.warn(
        "⚠️  [PGP] WARNING: All previously encrypted data is now unreadable!"
      );
    } catch (error) {
      console.error("[PGP] Failed to update encryption key:", error);
      throw new Error("Failed to update encryption key");
    }
  }

  /**
   * 🧪 Teste le chiffrement/déchiffrement (pour debug)
   * 
   * Vérifie que le chiffrement est fonctionnel et que la clé est correcte.
   * 
   * @returns Résultat du test avec le texte original et déchiffré
   * 
   * @example
   * const result = await PGPService.testEncryption();
   * console.log(result.success ? "✅ PGP OK" : "❌ PGP FAILED");
   */
  static async testEncryption(): Promise<{
    success: boolean;
    original: string;
    decrypted: string;
    bytesEncrypted: number;
    error?: string;
  }> {
    const testString = "Test TITAN V31.4 - PGP Encryption 🔒";

    try {
      console.log("[PGP] Testing encryption/decryption...");

      const encrypted = await this.encrypt(testString);
      const decrypted = await this.decrypt(encrypted);

      const success = decrypted === testString;

      return {
        success,
        original: testString,
        decrypted,
        bytesEncrypted: encrypted.length,
      };
    } catch (error) {
      console.error("[PGP] Test failed:", error);
      return {
        success: false,
        original: testString,
        decrypted: "",
        bytesEncrypted: 0,
        error: String(error),
      };
    }
  }
}