import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * ============================================================================
 * PATIENTS ROUTER
 * ============================================================================
 * 
 * Router pour la gestion des patients compatible TITAN V31.4.
 * 
 * Fonctionnalités :
 * - CRUD patients avec RLS automatique (isolation par centre)
 * - Recherche full-text avec search_vector + unaccent
 * - Archivage soft-delete (is_archived)
 * - Génération automatique patient_number
 * 
 * ⚠️ RLS : Toutes les requêtes sont automatiquement filtrées par center_id
 * grâce au middleware protectedProcedure qui applique setRLSContext().
 * 
 * Trigger PostgreSQL actif :
 * - trg_search_vector : Met à jour search_vector lors de l'insertion/modification
 */

// ============================================================================
// SCHEMAS DE VALIDATION
// ============================================================================

const patientSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email").optional().nullable(),
  phone: z.string().optional().nullable(),
  dob: z.string().optional().nullable(), // Format: YYYY-MM-DD
  gender: z.enum(["M", "F", "Other"]).optional().nullable(),
  patientNumber: z.string().optional().nullable(),
});

const searchSchema = z.object({
  query: z.string().min(1, "Search query is required"),
  limit: z.number().min(1).max(100).optional().default(20),
  includeArchived: z.boolean().optional().default(false),
});

const listSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
  includeArchived: z.boolean().optional().default(false),
});

// ============================================================================
// PATIENTS ROUTER
// ============================================================================

export const patientsRouter = router({
  /**
   * 📋 GET /api/patients/list
   * 
   * Liste des patients avec pagination.
   * Filtrée automatiquement par center_id (RLS).
   * 
   * @input { limit?, offset?, includeArchived? }
   * @returns Liste des patients
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
        `[Patients] Listing patients for center: ${ctx.user.centerId || "ALL (superadmin)"}`
      );

      // RLS filtre automatiquement par center_id
      const query = database
        .select()
        .from(schema.patients)
        .limit(input.limit)
        .offset(input.offset);

      // Filtre archivés si demandé
      if (!input.includeArchived) {
        query.where(sql`is_archived = false`);
      }

      const patients = await query;

      console.log(`[Patients] ✅ Found ${patients.length} patients`);

      return patients;
    }),

  /**
   * 🔍 GET /api/patients/search
   * 
   * Recherche full-text dans les patients.
   * Utilise l'index GIN sur search_vector pour une performance optimale.
   * 
   * La recherche porte sur :
   * - first_name (poids A)
   * - last_name (poids A)
   * - email (poids B)
   * - phone (poids B)
   * 
   * Ignore les accents grâce à unaccent().
   * 
   * @input { query, limit?, includeArchived? }
   * @returns Patients correspondants triés par pertinence
   * 
   * @example
   * search({ query: "mohamed", limit: 10 })
   * // Trouve "Mohamed", "Mohammed", "محمد" (si unaccent configuré)
   */
  search: protectedProcedure
    .input(searchSchema)
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      if (!database) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      console.log(
        `[Patients] Searching for: "${input.query}" ` +
        `(center: ${ctx.user.centerId || "ALL"})`
      );

      // Préparer la query de recherche
      // unaccent() normalise les accents, to_tsquery() crée le vecteur de recherche
      const searchQuery = input.query.trim().split(/\s+/).join(" | ");

      // Requête SQL avec full-text search
      // RLS filtre automatiquement par center_id
      const result = await database.execute(sql`
        SELECT 
          id, patient_number, first_name, last_name, dob, gender, 
          email, phone, is_archived, created_at, updated_at,
          ts_rank(search_vector, to_tsquery('simple', unaccent(${searchQuery}))) as rank
        FROM patients
        WHERE 
          search_vector @@ to_tsquery('simple', unaccent(${searchQuery}))
          ${input.includeArchived ? sql`` : sql`AND is_archived = false`}
        ORDER BY rank DESC
        LIMIT ${input.limit}
      `);

      const patients = result.rows;

      console.log(
        `[Patients] ✅ Search found ${patients.length} results ` +
        `for "${input.query}"`
      );

      return patients;
    }),

  /**
   * 👤 GET /api/patients/:id
   * 
   * Récupère un patient par ID.
   * Filtré automatiquement par RLS (seul le centre du patient peut y accéder).
   * 
   * @input { id: UUID }
   * @returns Patient complet
   * @throws NOT_FOUND si patient introuvable ou hors centre
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      console.log(`[Patients] Getting patient: ${input.id}`);

      const patient = await db.getPatientById(input.id);

      if (!patient) {
        console.error(`[Patients] Patient not found or access denied: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }

      console.log(`[Patients] ✅ Patient retrieved: ${patient.firstName} ${patient.lastName}`);

      return patient;
    }),

  /**
   * ➕ POST /api/patients
   * 
   * Crée un nouveau patient.
   * Assigne automatiquement le center_id de l'utilisateur connecté.
   * 
   * Workflow :
   * 1. Validation données
   * 2. Génération patient_number si non fourni
   * 3. Insertion avec center_id du user (RLS)
   * 4. Trigger trg_search_vector génère automatiquement search_vector
   * 
   * @input PatientSchema
   * @returns Patient créé
   * @throws FORBIDDEN si user sans centre
   */
  create: protectedProcedure
    .input(patientSchema)
    .mutation(async ({ input, ctx }) => {
      console.log(`[Patients] Creating patient: ${input.firstName} ${input.lastName}`);

      // Vérifier que l'utilisateur a un centre
      if (!ctx.user.centerId && !ctx.user.isSuperadmin) {
        console.error(`[Patients] User ${ctx.user.username} has no center assigned`);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You must be assigned to a center to create patients",
        });
      }

      // Générer patient_number si non fourni
      let patientNumber = input.patientNumber;
      if (!patientNumber) {
        // Format: C001-P000123 (C001 = code centre, P = Patient, 000123 = séquence)
        const centerCode = await db.getCenterById(ctx.user.centerId!)
          .then(c => c?.code || "UNKN");
        const timestamp = Date.now().toString().slice(-6);
        patientNumber = `${centerCode}-P${timestamp}`;
      }

      // Créer le patient
      const patient = await db.createPatient({
        centerId: ctx.user.centerId!,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email || null,
        phone: input.phone || null,
        dob: input.dob ? new Date(input.dob) : null,
        gender: input.gender || null,
        patientNumber,
        isArchived: false,
      });

      if (!patient) {
        console.error("[Patients] Failed to create patient");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create patient",
        });
      }

      console.log(`[Patients] ✅ Patient created: ${patient.patientNumber}`);

      return patient;
    }),

  /**
   * ✏️ PUT /api/patients/:id
   * 
   * Met à jour un patient.
   * RLS garantit que seul le centre propriétaire peut modifier.
   * 
   * Le trigger trg_search_vector met automatiquement à jour search_vector
   * si first_name, last_name ou email sont modifiés.
   * 
   * @input { id, data: Partial<PatientSchema> }
   * @returns Patient mis à jour
   * @throws NOT_FOUND si patient introuvable ou hors centre
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: patientSchema.partial(),
      })
    )
    .mutation(async ({ input }) => {
      console.log(`[Patients] Updating patient: ${input.id}`);

      // Vérifier que le patient existe (RLS filtre automatiquement)
      const existing = await db.getPatientById(input.id);
      if (!existing) {
        console.error(`[Patients] Patient not found or access denied: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }

      // Préparer les données de mise à jour
      const updateData: any = {};
      if (input.data.firstName !== undefined) updateData.firstName = input.data.firstName;
      if (input.data.lastName !== undefined) updateData.lastName = input.data.lastName;
      if (input.data.email !== undefined) updateData.email = input.data.email;
      if (input.data.phone !== undefined) updateData.phone = input.data.phone;
      if (input.data.dob !== undefined) updateData.dob = input.data.dob ? new Date(input.data.dob) : null;
      if (input.data.gender !== undefined) updateData.gender = input.data.gender;

      // Mise à jour
      const patient = await db.updatePatient(input.id, updateData);

      if (!patient) {
        console.error(`[Patients] Failed to update patient: ${input.id}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update patient",
        });
      }

      console.log(`[Patients] ✅ Patient updated: ${patient.patientNumber}`);

      return patient;
    }),

  /**
   * 🗑️ POST /api/patients/:id/archive
   * 
   * Archive un patient (soft delete).
   * Le patient n'est pas supprimé mais marqué is_archived = true.
   * 
   * Les patients archivés n'apparaissent plus dans les listes/recherches
   * par défaut mais peuvent être récupérés avec includeArchived: true.
   * 
   * @input { id }
   * @returns { success: true }
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Patients] Archiving patient: ${input.id}`);

      const patient = await db.getPatientById(input.id);
      if (!patient) {
        console.error(`[Patients] Patient not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }

      await db.updatePatient(input.id, { isArchived: true });

      console.log(`[Patients] ✅ Patient archived: ${patient.patientNumber}`);

      return { success: true };
    }),

  /**
   * ♻️ POST /api/patients/:id/unarchive
   * 
   * Désarchive un patient.
   * 
   * @input { id }
   * @returns { success: true }
   */
  unarchive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      console.log(`[Patients] Unarchiving patient: ${input.id}`);

      const patient = await db.getPatientById(input.id);
      if (!patient) {
        console.error(`[Patients] Patient not found: ${input.id}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }

      await db.updatePatient(input.id, { isArchived: false });

      console.log(`[Patients] ✅ Patient unarchived: ${patient.patientNumber}`);

      return { success: true };
    }),

  /**
   * 📊 GET /api/patients/stats
   * 
   * Statistiques des patients du centre.
   * 
   * @returns { total, active, archived }
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const database = await getDb();
    if (!database) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
      });
    }

    console.log(`[Patients] Getting stats for center: ${ctx.user.centerId || "ALL"}`);

    // RLS filtre automatiquement par center_id
    const result = await database.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_archived = false) as active,
        COUNT(*) FILTER (WHERE is_archived = true) as archived
      FROM patients
    `);

    const stats = result.rows[0] as any;

    console.log(`[Patients] ✅ Stats: ${JSON.stringify(stats)}`);

    return {
      total: parseInt(stats.total || "0"),
      active: parseInt(stats.active || "0"),
      archived: parseInt(stats.archived || "0"),
    };
  }),
});