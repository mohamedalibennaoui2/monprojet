import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { AuthService } from "../services/auth";

/**
 * ============================================================================
 * USERS ROUTER (RBAC)
 * ============================================================================
 * 
 * Router pour la gestion des utilisateurs et RBAC.
 * 
 * Fonctionnalités :
 * - CRUD users avec RLS (users voient leur centre)
 * - Gestion des rôles (role assignment)
 * - Gestion des permissions
 * - Activation/désactivation comptes
 * 
 * ⚠️ RLS : Policy users_center permet :
 * - Superadmins : voir tous les users
 * - Users normaux : voir seulement users de leur centre
 */

// ============================================================================
// SCHEMAS
// ============================================================================

const userCreateSchema = z.object({
  username: z.string().min(3),
  email: z.string().email(),
  fullName: z.string().min(1),
  password: z.string().min(8),
  centerId: z.string().uuid().optional(),
  isSuperadmin: z.boolean().optional().default(false),
});

const userUpdateSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().min(1).optional(),
  password: z.string().min(8).optional(),
  centerId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
  isSuperadmin: z.boolean().optional(),
});

const assignRoleSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
});

// ============================================================================
// USERS ROUTER
// ============================================================================

export const usersRouter = router({
  /**
   * 📋 GET /api/users/list
   * 
   * Liste des utilisateurs.
   * - Superadmin : voit tous les users
   * - User normal : voit seulement users de son centre (RLS)
   */
  list: protectedProcedure
    .input(
      z.object({
        centerId: z.string().uuid().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().min(1).max(100).optional().default(50),
        offset: z.number().min(0).optional().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Users] Listing users for center: ${ctx.user.centerId || "ALL"}`);

      let query = database
        .select()
        .from(schema.users)
        .limit(input.limit)
        .offset(input.offset);

      const conditions = [];
      if (input.centerId) {
        conditions.push(sql`center_id = ${input.centerId}`);
      }
      if (input.isActive !== undefined) {
        conditions.push(sql`is_active = ${input.isActive}`);
      }

      if (conditions.length > 0) {
        query = query.where(sql.join(conditions, sql` AND `));
      }

      const users = await query;

      console.log(`[Users] ✅ Found ${users.length} users`);

      // Ne pas exposer les mots de passe
      return users.map((u) => ({
        ...u,
        hashedPassword: undefined,
      }));
    }),

  /**
   * 👤 GET /api/users/:id
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const user = await db.getUserById(input.id);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      return {
        ...user,
        hashedPassword: undefined,
      };
    }),

  /**
   * ➕ POST /api/users (Admin only)
   * 
   * Crée un nouvel utilisateur.
   * Seuls les admins peuvent créer des users.
   */
  create: adminProcedure
    .input(userCreateSchema)
    .mutation(async ({ input }) => {
      console.log(`[Users] Creating user: ${input.username}`);

      // Vérifier username unique
      const existing = await db.getUserByUsername(input.username);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Username already exists",
        });
      }

      // Vérifier email unique
      const existingEmail = await db.getUserByEmail(input.email);
      if (existingEmail) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email already exists",
        });
      }

      // Hash password
      const hashedPassword = await AuthService.hashPassword(input.password);

      // Créer user
      const user = await db.createUser({
        username: input.username,
        email: input.email,
        fullName: input.fullName,
        hashedPassword,
        centerId: input.centerId || null,
        isSuperadmin: input.isSuperadmin || false,
        isActive: true,
      });

      if (!user) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user",
        });
      }

      console.log(`[Users] ✅ User created: ${user.username}`);

      return {
        ...user,
        hashedPassword: undefined,
      };
    }),

  /**
   * ✏️ PUT /api/users/:id (Admin only)
   */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: userUpdateSchema,
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Users] Updating user: ${input.id}`);

      const existing = await db.getUserById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      const updateData: any = { ...input.data };

      // Hash nouveau password si fourni
      if (input.data.password) {
        updateData.hashedPassword = await AuthService.hashPassword(
          input.data.password
        );
        delete updateData.password;
      }

      const user = await db.updateUser(input.id, updateData);

      if (!user) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update user",
        });
      }

      console.log(`[Users] ✅ User updated: ${user.username}`);

      return {
        ...user,
        hashedPassword: undefined,
      };
    }),

  /**
   * 🔒 POST /api/users/:id/activate (Admin only)
   */
  activate: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.updateUser(input.id, { isActive: true });
      console.log(`[Users] ✅ User activated: ${input.id}`);
      return { success: true };
    }),

  /**
   * 🔒 POST /api/users/:id/deactivate (Admin only)
   */
  deactivate: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.updateUser(input.id, { isActive: false });
      console.log(`[Users] ✅ User deactivated: ${input.id}`);
      return { success: true };
    }),

  /**
   * 👥 GET /api/users/:id/roles
   */
  getRoles: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input }) => {
      const roles = await db.getUserRoles(input.userId);
      console.log(`[Users] ✅ Found ${roles.length} roles for user ${input.userId}`);
      return roles;
    }),

  /**
   * ➕ POST /api/users/:id/roles (Admin only)
   */
  assignRole: adminProcedure
    .input(assignRoleSchema)
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(`[Users] Assigning role ${input.roleId} to user ${input.userId}`);

      try {
        await database.insert(schema.userRoles).values({
          userId: input.userId,
          roleId: input.roleId,
        });

        console.log(`[Users] ✅ Role assigned`);
        return { success: true };
      } catch (error: any) {
        if (error.code === "23505") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "User already has this role",
          });
        }
        throw error;
      }
    }),

  /**
   * ❌ DELETE /api/users/:userId/roles/:roleId (Admin only)
   */
  removeRole: adminProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        roleId: z.string().uuid(),
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

      console.log(`[Users] Removing role ${input.roleId} from user ${input.userId}`);

      await database
        .delete(schema.userRoles)
        .where(
          sql`user_id = ${input.userId} AND role_id = ${input.roleId}`
        );

      console.log(`[Users] ✅ Role removed`);
      return { success: true };
    }),
});