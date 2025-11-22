import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "../_core/cookies";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { sdk } from "../_core/sdk";
import * as db from "../db";
import { AuthService } from "../services/auth";

/**
 * ============================================================================
 * AUTHENTICATION ROUTER
 * ============================================================================
 * 
 * Router d'authentification compatible TITAN V31.4.
 * 
 * Fonctionnalités :
 * - Login local (username/password) avec PostgreSQL crypt()
 * - Register (création compte) avec gen_salt('bf')
 * - Me (profil utilisateur)
 * - Logout (suppression cookie)
 * - Change password (avec vérification ancienne)
 * 
 * Tous les mots de passe sont hashés avec PostgreSQL pgcrypto.
 */

// ============================================================================
// SCHEMAS DE VALIDATION
// ============================================================================

const loginSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  email: z.string().email("Invalid email address"),
  fullName: z.string().min(1, "Full name is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  centerId: z.string().uuid("Invalid center ID").optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

// ============================================================================
// AUTH ROUTER
// ============================================================================

export const authRouter = router({
  /**
   * 👤 GET /api/auth/me
   * 
   * Retourne le profil de l'utilisateur connecté.
   * Utilise ctx.user qui est automatiquement rempli par le middleware SDK.
   * 
   * @returns User complet ou null si non connecté
   */
  me: publicProcedure.query((opts) => {
    if (!opts.ctx.user) {
      return null;
    }

    console.log(`[Auth] User profile requested: ${opts.ctx.user.username}`);

    return {
      id: opts.ctx.user.id,
      username: opts.ctx.user.username,
      email: opts.ctx.user.email,
      fullName: opts.ctx.user.fullName,
      centerId: opts.ctx.user.centerId,
      isSuperadmin: opts.ctx.user.isSuperadmin,
      isActive: opts.ctx.user.isActive,
      emailVerified: opts.ctx.user.emailVerified,
      lastLogin: opts.ctx.user.lastLogin,
    };
  }),

  /**
   * 🔐 POST /api/auth/login
   * 
   * Authentification locale avec PostgreSQL crypt().
   * 
   * Workflow :
   * 1. Recherche utilisateur par username
   * 2. Vérification mot de passe avec AuthService.verifyPassword()
   * 3. Mise à jour last_login
   * 4. Création session JWT
   * 5. Envoi cookie de session
   * 
   * @input { username, password }
   * @returns { success: true, user }
   * @throws UNAUTHORIZED si identifiants invalides
   * @throws NOT_FOUND si utilisateur introuvable
   */
  login: publicProcedure
    .input(loginSchema)
    .mutation(async ({ input, ctx }) => {
      console.log(`[Auth] Login attempt for username: ${input.username}`);

      // 1. Recherche utilisateur
      const user = await db.getUserByUsername(input.username);

      if (!user) {
        console.error(`[Auth] User not found: ${input.username}`);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid username or password",
        });
      }

      // Vérifier que l'utilisateur est actif
      if (!user.isActive) {
        console.error(`[Auth] Inactive user login attempt: ${input.username}`);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Account is inactive. Contact administrator.",
        });
      }

      // 2. Vérification mot de passe avec PostgreSQL crypt()
      const passwordMatch = await AuthService.verifyPassword(
        input.password,
        user.hashedPassword
      );

      if (!passwordMatch) {
        console.error(`[Auth] Invalid password for user: ${input.username}`);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid username or password",
        });
      }

      // 3. Mise à jour last_login
      await db.updateUser(user.id, { lastLogin: new Date() });

      // 4. Création session JWT
      const sessionToken = await sdk.createSessionToken(user.username, {
        name: user.fullName,
        expiresInMs: 365 * 24 * 60 * 60 * 1000, // 1 an
      });

      // 5. Envoi cookie de session
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: 365 * 24 * 60 * 60 * 1000,
      });

      console.log(`[Auth] ✅ Login successful for user: ${user.username}`);

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
          centerId: user.centerId,
          isSuperadmin: user.isSuperadmin,
        },
      };
    }),

  /**
   * 📝 POST /api/auth/register
   * 
   * Création d'un nouveau compte utilisateur.
   * 
   * Workflow :
   * 1. Validation force du mot de passe
   * 2. Vérification username/email uniques
   * 3. Hash du mot de passe avec AuthService.hashPassword()
   * 4. Création utilisateur en DB
   * 5. Assignation au centre par défaut si fourni
   * 
   * @input { username, email, fullName, password, centerId? }
   * @returns User créé
   * @throws CONFLICT si username/email existe déjà
   * @throws BAD_REQUEST si mot de passe trop faible
   */
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ input }) => {
      console.log(`[Auth] Registration attempt for username: ${input.username}`);

      // 1. Validation force du mot de passe
      const passwordValidation = AuthService.validatePasswordStrength(
        input.password
      );

      if (!passwordValidation.isValid) {
        console.error(`[Auth] Weak password: ${passwordValidation.errors.join(", ")}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Password is too weak: ${passwordValidation.errors.join(", ")}`,
        });
      }

      // 2. Vérification username unique
      const existingUser = await db.getUserByUsername(input.username);
      if (existingUser) {
        console.error(`[Auth] Username already exists: ${input.username}`);
        throw new TRPCError({
          code: "CONFLICT",
          message: "Username already exists",
        });
      }

      // Vérification email unique
      const existingEmail = await db.getUserByEmail(input.email);
      if (existingEmail) {
        console.error(`[Auth] Email already exists: ${input.email}`);
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email already exists",
        });
      }

      // 3. Hash du mot de passe avec PostgreSQL gen_salt('bf')
      const hashedPassword = await AuthService.hashPassword(input.password);

      // 4. Création utilisateur
      const user = await db.createUser({
        username: input.username,
        email: input.email,
        fullName: input.fullName,
        hashedPassword,
        centerId: input.centerId || null,
        isActive: true,
        isSuperadmin: false,
        emailVerified: false,
      });

      if (!user) {
        console.error("[Auth] Failed to create user in database");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user",
        });
      }

      console.log(`[Auth] ✅ User registered successfully: ${user.username}`);

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        centerId: user.centerId,
      };
    }),

  /**
   * 🚪 POST /api/auth/logout
   * 
   * Déconnexion de l'utilisateur.
   * Supprime le cookie de session.
   * 
   * @returns { success: true }
   */
  logout: publicProcedure.mutation(({ ctx }) => {
    const username = ctx.user?.username || "anonymous";
    console.log(`[Auth] Logout request from user: ${username}`);

    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, {
      ...cookieOptions,
      maxAge: -1,
    });

    console.log(`[Auth] ✅ Logout successful for user: ${username}`);

    return { success: true };
  }),

  /**
   * 🔑 POST /api/auth/change-password
   * 
   * Changement de mot de passe (utilisateur connecté).
   * 
   * Workflow :
   * 1. Vérification mot de passe actuel
   * 2. Validation force nouveau mot de passe
   * 3. Hash nouveau mot de passe
   * 4. Mise à jour en DB
   * 
   * @input { currentPassword, newPassword }
   * @returns { success: true }
   * @throws UNAUTHORIZED si mot de passe actuel invalide
   * @throws BAD_REQUEST si nouveau mot de passe trop faible
   */
  changePassword: protectedProcedure
    .input(changePasswordSchema)
    .mutation(async ({ input, ctx }) => {
      const user = ctx.user;

      console.log(`[Auth] Password change request for user: ${user.username}`);

      // 1. Vérifier mot de passe actuel
      const passwordMatch = await AuthService.verifyPassword(
        input.currentPassword,
        user.hashedPassword
      );

      if (!passwordMatch) {
        console.error(`[Auth] Invalid current password for user: ${user.username}`);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Current password is incorrect",
        });
      }

      // 2. Valider force nouveau mot de passe
      const passwordValidation = AuthService.validatePasswordStrength(
        input.newPassword
      );

      if (!passwordValidation.isValid) {
        console.error(
          `[Auth] New password too weak: ${passwordValidation.errors.join(", ")}`
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `New password is too weak: ${passwordValidation.errors.join(", ")}`,
        });
      }

      // Vérifier que le nouveau mot de passe est différent
      if (input.currentPassword === input.newPassword) {
        console.error("[Auth] New password same as current password");
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "New password must be different from current password",
        });
      }

      // 3. Hash nouveau mot de passe
      const hashedPassword = await AuthService.hashPassword(input.newPassword);

      // 4. Mise à jour en DB
      await db.updateUser(user.id, { hashedPassword });

      console.log(`[Auth] ✅ Password changed successfully for user: ${user.username}`);

      return { success: true };
    }),

  /**
   * 🧪 GET /api/auth/test
   * 
   * Endpoint de test pour vérifier que le système d'auth fonctionne.
   * Teste le hashing/vérification PostgreSQL.
   * 
   * ⚠️ À SUPPRIMER EN PRODUCTION
   * 
   * @returns Résultat des tests
   */
  test: publicProcedure.query(async () => {
    console.log("[Auth] Running authentication system test...");

    const result = await AuthService.testPasswordHashing();

    return {
      authSystem: result.success ? "OK" : "FAILED",
      hashGenerated: result.hashGenerated,
      verificationPassed: result.verificationPassed,
      error: result.error,
    };
  }),
});