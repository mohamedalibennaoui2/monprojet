import { sql } from "drizzle-orm";
import { getDb } from "../db";

/**
 * ============================================================================
 * AUTHENTICATION SERVICE (PostgreSQL crypt/gen_salt)
 * ============================================================================
 * 
 * Service d'authentification utilisant les fonctions PostgreSQL natives.
 * Compatible avec le schéma TITAN V31.4 GOLD MASTER.
 * 
 * Fonctions PostgreSQL utilisées :
 * - crypt(password, salt) : Hash un mot de passe avec bcrypt
 * - gen_salt('bf') : Génère un salt bcrypt
 * - Vérification : crypt(input, hash) = hash
 * 
 * ⚠️ Utilise les fonctions PostgreSQL pgcrypto (extension requise)
 */

export class AuthService {
  /**
   * ✅ Vérifie un mot de passe avec crypt() PostgreSQL
   * 
   * Utilise la fonction PostgreSQL crypt() pour vérifier le mot de passe.
   * Compatible avec gen_salt('bf') utilisé dans le schéma V31.4.
   * 
   * La vérification se fait côté PostgreSQL, pas en Node.js !
   * Cela garantit la compatibilité avec les hashs créés directement en SQL.
   * 
   * @param plainPassword - Mot de passe en clair saisi par l'utilisateur
   * @param hashedPassword - Hash bcrypt stocké en DB
   * @returns true si le mot de passe est valide
   * 
   * @example
   * const isValid = await AuthService.verifyPassword(
   *   "Admin123!",
   *   user.hashedPassword
   * );
   */
  static async verifyPassword(
    plainPassword: string,
    hashedPassword: string
  ): Promise<boolean> {
    const db = await getDb();
    if (!db) {
      throw new Error("[Auth] Database not available");
    }

    if (!plainPassword || !hashedPassword) {
      return false;
    }

    try {
      console.log("[Auth] Verifying password with PostgreSQL crypt()...");

      // Vérification côté PostgreSQL
      // Si crypt(password, hash) == hash, alors le mot de passe est valide
      const result = await db.execute(sql`
        SELECT (${hashedPassword} = crypt(${plainPassword}, ${hashedPassword})) as valid
      `);

      const isValid = (result.rows[0] as any)?.valid === true;

      if (isValid) {
        console.log("[Auth] ✅ Password verification successful");
      } else {
        console.log("[Auth] ❌ Password verification failed");
      }

      return isValid;
    } catch (error) {
      console.error("[Auth] Password verification error:", error);
      return false;
    }
  }

  /**
   * 🔒 Hash un mot de passe avec gen_salt('bf')
   * 
   * Utilise la fonction PostgreSQL crypt() avec gen_salt('bf').
   * Le 'bf' signifie Blowfish (bcrypt algorithm).
   * 
   * Le hash généré est compatible avec les standards bcrypt
   * et peut être vérifié avec verifyPassword().
   * 
   * @param plainPassword - Mot de passe en clair
   * @returns Hash bcrypt prêt à être stocké en DB
   * @throws Error si le hashing échoue
   * 
   * @example
   * const hashedPassword = await AuthService.hashPassword("Admin123!");
   * // hashedPassword commence par $2a$ (bcrypt)
   */
  static async hashPassword(plainPassword: string): Promise<string> {
    const db = await getDb();
    if (!db) {
      throw new Error("[Auth] Database not available");
    }

    if (!plainPassword || plainPassword.length < 8) {
      throw new Error(
        "[Auth] Password must be at least 8 characters long"
      );
    }

    try {
      console.log("[Auth] Hashing password with PostgreSQL gen_salt('bf')...");

      // Hash côté PostgreSQL avec bcrypt
      const result = await db.execute(sql`
        SELECT crypt(${plainPassword}, gen_salt('bf')) as hashed
      `);

      const hashed = (result.rows[0] as any)?.hashed;

      if (!hashed) {
        throw new Error("Hashing returned null");
      }

      console.log("[Auth] ✅ Password hashed successfully");

      return hashed;
    } catch (error) {
      console.error("[Auth] Password hashing error:", error);
      throw new Error(`Password hashing failed: ${error}`);
    }
  }

  /**
   * 🔄 Re-hash un mot de passe (pour rotation de sel)
   * 
   * Vérifie d'abord l'ancien mot de passe, puis génère un nouveau hash.
   * Utile pour la rotation périodique des hashs.
   * 
   * @param plainPassword - Mot de passe en clair
   * @param currentHash - Hash actuel en DB
   * @returns Nouveau hash ou null si l'ancien mot de passe est invalide
   * 
   * @example
   * const newHash = await AuthService.rehashPassword("Admin123!", user.hashedPassword);
   * if (newHash) {
   *   await db.updateUser(user.id, { hashedPassword: newHash });
   * }
   */
  static async rehashPassword(
    plainPassword: string,
    currentHash: string
  ): Promise<string | null> {
    // Vérifier d'abord que le mot de passe actuel est correct
    const isValid = await this.verifyPassword(plainPassword, currentHash);

    if (!isValid) {
      console.log("[Auth] ❌ Cannot rehash - invalid password");
      return null;
    }

    // Générer un nouveau hash
    return await this.hashPassword(plainPassword);
  }

  /**
   * 🔐 Valide la force d'un mot de passe
   * 
   * Règles :
   * - Minimum 8 caractères
   * - Au moins 1 majuscule
   * - Au moins 1 minuscule
   * - Au moins 1 chiffre
   * - Au moins 1 caractère spécial
   * 
   * @param password - Mot de passe à valider
   * @returns Objet avec isValid et les erreurs éventuelles
   * 
   * @example
   * const validation = AuthService.validatePasswordStrength("Admin123!");
   * if (!validation.isValid) {
   *   throw new Error(validation.errors.join(", "));
   * }
   */
  static validatePasswordStrength(password: string): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (password.length < 8) {
      errors.push("Password must be at least 8 characters long");
    }

    if (!/[A-Z]/.test(password)) {
      errors.push("Password must contain at least one uppercase letter");
    }

    if (!/[a-z]/.test(password)) {
      errors.push("Password must contain at least one lowercase letter");
    }

    if (!/[0-9]/.test(password)) {
      errors.push("Password must contain at least one digit");
    }

    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      errors.push("Password must contain at least one special character");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 🧪 Teste le hashing/vérification (pour debug)
   * 
   * Vérifie que les fonctions PostgreSQL crypt/gen_salt sont disponibles.
   * 
   * @returns Résultat du test
   * 
   * @example
   * const result = await AuthService.testPasswordHashing();
   * console.log(result.success ? "✅ Auth OK" : "❌ Auth FAILED");
   */
  static async testPasswordHashing(): Promise<{
    success: boolean;
    testPassword: string;
    hashGenerated: boolean;
    verificationPassed: boolean;
    error?: string;
  }> {
    const testPassword = "TestPassword123!";

    try {
      console.log("[Auth] Testing password hashing/verification...");

      // 1. Hash
      const hashed = await this.hashPassword(testPassword);
      const hashGenerated = hashed.startsWith("$2a$") || hashed.startsWith("$2b$");

      // 2. Vérification positive
      const validPassword = await this.verifyPassword(testPassword, hashed);

      // 3. Vérification négative
      const invalidPassword = await this.verifyPassword("WrongPassword!", hashed);

      const success = hashGenerated && validPassword && !invalidPassword;

      return {
        success,
        testPassword,
        hashGenerated,
        verificationPassed: validPassword && !invalidPassword,
      };
    } catch (error) {
      console.error("[Auth] Test failed:", error);
      return {
        success: false,
        testPassword,
        hashGenerated: false,
        verificationPassed: false,
        error: String(error),
      };
    }
  }

  /**
   * 🔑 Génère un mot de passe aléatoire sécurisé
   * 
   * Utile pour les comptes temporaires ou les réinitialisations.
   * 
   * @param length - Longueur du mot de passe (min 12, défaut 16)
   * @returns Mot de passe aléatoire respectant les règles de force
   * 
   * @example
   * const tempPassword = AuthService.generateSecurePassword();
   * // Envoyer par email à l'utilisateur
   */
  static generateSecurePassword(length: number = 16): string {
    if (length < 12) {
      throw new Error("Password length must be at least 12 characters");
    }

    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const digits = "0123456789";
    const special = "!@#$%^&*(),.?:{}|<>";

    const allChars = uppercase + lowercase + digits + special;

    let password = "";

    // Garantir au moins 1 caractère de chaque type
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += digits[Math.floor(Math.random() * digits.length)];
    password += special[Math.floor(Math.random() * special.length)];

    // Compléter avec des caractères aléatoires
    for (let i = password.length; i < length; i++) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // Mélanger les caractères
    return password
      .split("")
      .sort(() => Math.random() - 0.5)
      .join("");
  }
}