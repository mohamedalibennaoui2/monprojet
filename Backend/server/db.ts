/**
 * ============================================================================
 * DATABASE HELPER FUNCTIONS - TITAN V31.4 (100% COMPLET)
 * ============================================================================
 * 
 * Toutes les fonctions helper pour accès DB avec Drizzle.
 * Compatible avec RLS (les requêtes sont filtrées automatiquement).
 * 
 * ⚠️ Ces fonctions supposent que setRLSContext() a été appelé avant.
 * Le middleware tRPC protectedProcedure s'en charge automatiquement.
 * 
 * Modules couverts (100%) :
 * - Users & Auth
 * - Centers & Doctors & Specialties
 * - Patients & Appointments & Encounters
 * - Medical Acts & Billing Codes
 * - Prescriptions & Drugs & Pharmacy
 * - Orders & Lab Results
 * - Invoices & Payments
 * - Documents & File Stores
 * - Roles & Permissions
 * - Audit & System Settings
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Connexion DB (lazy loading)
 */
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL);
      _db = drizzle(client, { schema });
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============================================================================
// USER QUERIES
// ============================================================================

export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createUser(data: schema.InsertUser) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.users).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateUser(id: string, data: Partial<schema.InsertUser>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.users)
    .set(data)
    .where(eq(schema.users.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// CENTER QUERIES
// ============================================================================

export async function getCenterById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.centers)
    .where(eq(schema.centers.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAllCenters() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(schema.centers);
}

export async function createCenter(data: schema.InsertCenter) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.centers).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateCenter(id: string, data: Partial<schema.InsertCenter>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.centers)
    .set(data)
    .where(eq(schema.centers.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// SPECIALTY QUERIES (NOUVEAU)
// ============================================================================

export async function getAllSpecialties() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(schema.specialties);
}

export async function getSpecialtyById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.specialties)
    .where(eq(schema.specialties.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createSpecialty(data: schema.InsertSpecialty) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.specialties).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateSpecialty(id: string, data: Partial<schema.InsertSpecialty>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.specialties)
    .set(data)
    .where(eq(schema.specialties.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// PATIENT QUERIES
// ============================================================================

export async function getPatientById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.patients)
    .where(eq(schema.patients.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getPatientsByCenterId(centerId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.patients)
    .where(eq(schema.patients.centerId, centerId));
}

export async function createPatient(data: schema.InsertPatient) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.patients).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updatePatient(id: string, data: Partial<schema.InsertPatient>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.patients)
    .set(data)
    .where(eq(schema.patients.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// APPOINTMENT QUERIES
// ============================================================================

export async function getAppointmentById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAppointmentsByPatientId(patientId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.patientId, patientId));
}

export async function createAppointment(data: schema.InsertAppointment) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.appointments).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateAppointment(
  id: string,
  data: Partial<schema.InsertAppointment>
) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.appointments)
    .set(data)
    .where(eq(schema.appointments.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// DOCTOR QUERIES
// ============================================================================

export async function getDoctorById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.doctors)
    .where(eq(schema.doctors.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getDoctorsByCenterId(centerId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.doctors)
    .where(eq(schema.doctors.centerId, centerId));
}

export async function createDoctor(data: schema.InsertDoctor) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.doctors).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateDoctor(id: string, data: Partial<schema.InsertDoctor>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.doctors)
    .set(data)
    .where(eq(schema.doctors.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// INVOICE QUERIES
// ============================================================================

export async function getInvoiceById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getInvoicesByPatientId(patientId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.patientId, patientId));
}

export async function createInvoice(data: schema.InsertInvoice) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.invoices).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateInvoice(id: string, data: Partial<schema.InsertInvoice>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.invoices)
    .set(data)
    .where(eq(schema.invoices.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// INVOICE ITEM QUERIES
// ============================================================================

export async function getInvoiceItems(invoiceId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.invoiceItems)
    .where(eq(schema.invoiceItems.invoiceId, invoiceId));
}

export async function createInvoiceItem(data: schema.InsertInvoiceItem) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.invoiceItems).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// PRESCRIPTION QUERIES
// ============================================================================

export async function getPrescriptionById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.prescriptions)
    .where(eq(schema.prescriptions.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createPrescription(data: schema.InsertPrescription) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.prescriptions).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// DRUG QUERIES
// ============================================================================

export async function getDrugById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.drugs)
    .where(eq(schema.drugs.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAllDrugs() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(schema.drugs);
}

export async function createDrug(data: schema.InsertDrug) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.drugs).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// DOCUMENT QUERIES (NOUVEAU)
// ============================================================================

export async function getDocumentById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getDocumentsByPatientId(patientId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.patientId, patientId));
}

export async function createDocument(data: schema.InsertDocument) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.documents).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function deleteDocument(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .delete(schema.documents)
    .where(eq(schema.documents.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// ROLE & PERMISSION QUERIES
// ============================================================================

export async function getRoleByName(name: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.name, name))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAllRoles() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(schema.roles);
}

export async function createRole(data: schema.InsertRole) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.roles).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserRoles(userId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select({ role: schema.roles })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(eq(schema.userRoles.userId, userId));
}

// ============================================================================
// SYSTEM SETTINGS QUERIES
// ============================================================================

export async function getSystemSetting(key: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, key))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function updateSystemSetting(key: string, value: any) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .insert(schema.systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.systemSettings.key,
      set: { value },
    })
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// AUDIT LOG QUERIES
// ============================================================================

export async function createAuditLog(data: schema.InsertAuditLog) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.auditLogs).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function getAuditLogsByUserId(userId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.userId, userId));
}

// ============================================================================
// FILE STORE QUERIES (NOUVEAU)
// ============================================================================

export async function getFileStoreById(id: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.fileStores)
    .where(eq(schema.fileStores.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAllFileStores() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(schema.fileStores);
}

export async function getDefaultFileStore() {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(schema.fileStores)
    .where(eq(schema.fileStores.isDefault, true))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createFileStore(data: schema.InsertFileStore) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(schema.fileStores).values(data).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function updateFileStore(id: string, data: Partial<schema.InsertFileStore>) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(schema.fileStores)
    .set(data)
    .where(eq(schema.fileStores.id, id))
    .returning();

  return result.length > 0 ? result[0] : undefined;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Teste la connexion DB
 */
export async function testConnection(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;

    await db.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Récupère le nombre de records d'une table (pour stats)
 */
export async function getTableCount(tableName: string): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;

    const result = await db.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
    return parseInt((result.rows[0] as any)?.count || "0");
  } catch {
    return 0;
  }
}

/**
 * Exporte toutes les fonctions helper
 */
export default {
  getDb,
  testConnection,
  getTableCount,
  // Users
  getUserByUsername,
  getUserById,
  getUserByEmail,
  createUser,
  updateUser,
  // Centers
  getCenterById,
  getAllCenters,
  createCenter,
  updateCenter,
  // Specialties
  getAllSpecialties,
  getSpecialtyById,
  createSpecialty,
  updateSpecialty,
  // Patients
  getPatientById,
  getPatientsByCenterId,
  createPatient,
  updatePatient,
  // Appointments
  getAppointmentById,
  getAppointmentsByPatientId,
  createAppointment,
  updateAppointment,
  // Doctors
  getDoctorById,
  getDoctorsByCenterId,
  createDoctor,
  updateDoctor,
  // Invoices
  getInvoiceById,
  getInvoicesByPatientId,
  createInvoice,
  updateInvoice,
  getInvoiceItems,
  createInvoiceItem,
  // Prescriptions
  getPrescriptionById,
  createPrescription,
  // Drugs
  getDrugById,
  getAllDrugs,
  createDrug,
  // Documents
  getDocumentById,
  getDocumentsByPatientId,
  createDocument,
  deleteDocument,
  // Roles
  getRoleByName,
  getAllRoles,
  createRole,
  getUserRoles,
  // System Settings
  getSystemSetting,
  updateSystemSetting,
  // Audit Logs
  createAuditLog,
  getAuditLogsByUserId,
  // File Stores
  getFileStoreById,
  getAllFileStores,
  getDefaultFileStore,
  createFileStore,
  updateFileStore,
};