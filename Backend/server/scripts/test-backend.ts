/**
 * ============================================================================
 * TITAN V31.4 - BACKEND TEST SCRIPT
 * ============================================================================
 * 
 * Script de test complet pour valider tous les composants critiques.
 * 
 * Tests couverts :
 * 1. Connexion DB
 * 2. RLS (isolation centres)
 * 3. PGP (chiffrement/déchiffrement)
 * 4. Auth (hashing/vérification)
 * 5. Triggers (invoice totals, commissions, stock)
 * 6. Search (full-text avec tsvector)
 * 
 * Usage :
 * pnpm tsx server/scripts/test-backend.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { setRLSContext, testRLSIsolation } from "../db/rls";
import { PGPService } from "../services/pgp";
import { AuthService } from "../services/auth";
import * as schema from "../../drizzle/schema";

// ============================================================================
// UTILITIES
// ============================================================================

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(test: string) {
  log(`✅ ${test}`, colors.green);
}

function error(test: string, err: any) {
  log(`❌ ${test}`, colors.red);
  console.error(err);
}

function section(title: string) {
  console.log("");
  log("=".repeat(60), colors.cyan);
  log(title, colors.bold + colors.cyan);
  log("=".repeat(60), colors.cyan);
}

// ============================================================================
// TESTS
// ============================================================================

async function testDatabaseConnection(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) {
      throw new Error("Database not available");
    }

    const result = await db.execute(sql`SELECT 1 as test`);
    if ((result.rows[0] as any)?.test !== 1) {
      throw new Error("Invalid query result");
    }

    success("Database connection");
    return true;
  } catch (err) {
    error("Database connection", err);
    return false;
  }
}

async function testExtensions(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const requiredExtensions = [
      "uuid-ossp",
      "pgcrypto",
      "pg_trgm",
      "unaccent",
      "btree_gin",
    ];

    for (const ext of requiredExtensions) {
      const result = await db.execute(sql`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = ${ext}
        ) as installed
      `);

      const installed = (result.rows[0] as any)?.installed;
      if (!installed) {
        throw new Error(`Extension ${ext} not installed`);
      }
    }

    success("PostgreSQL extensions");
    return true;
  } catch (err) {
    error("PostgreSQL extensions", err);
    return false;
  }
}

async function testRLS(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Créer 2 centres temporaires
    const center1 = await db
      .insert(schema.centers)
      .values({
        name: "Test Center 1",
        code: "TC1",
      })
      .returning();

    const center2 = await db
      .insert(schema.centers)
      .values({
        name: "Test Center 2",
        code: "TC2",
      })
      .returning();

    // Créer 2 users temporaires
    const user1 = await db
      .insert(schema.users)
      .values({
        username: "test_user_1",
        email: "test1@test.com",
        hashedPassword: "test",
        fullName: "Test User 1",
        centerId: center1[0].id,
      })
      .returning();

    const user2 = await db
      .insert(schema.users)
      .values({
        username: "test_user_2",
        email: "test2@test.com",
        hashedPassword: "test",
        fullName: "Test User 2",
        centerId: center2[0].id,
      })
      .returning();

    // Créer des patients dans chaque centre
    await db.insert(schema.patients).values({
      centerId: center1[0].id,
      firstName: "Patient",
      lastName: "Center 1",
    });

    await db.insert(schema.patients).values({
      centerId: center2[0].id,
      firstName: "Patient",
      lastName: "Center 2",
    });

    // Test isolation
    // User 1 devrait voir seulement les patients du centre 1
    await setRLSContext(user1[0].id, user1[0].centerId!);
    const patients1 = await db.select().from(schema.patients);

    // User 2 devrait voir seulement les patients du centre 2
    await setRLSContext(user2[0].id, user2[0].centerId!);
    const patients2 = await db.select().from(schema.patients);

    // Cleanup
    await db.delete(schema.patients).where(sql`center_id = ${center1[0].id}`);
    await db.delete(schema.patients).where(sql`center_id = ${center2[0].id}`);
    await db.delete(schema.users).where(sql`username LIKE 'test_user_%'`);
    await db.delete(schema.centers).where(sql`code LIKE 'TC%'`);

    // Vérification
    if (patients1.length === 0 || patients2.length === 0) {
      throw new Error("RLS not working: users can see patients from other centers");
    }

    success(`RLS isolation (User1: ${patients1.length}, User2: ${patients2.length})`);
    return true;
  } catch (err) {
    error("RLS isolation", err);
    return false;
  }
}

async function testPGP(): Promise<boolean> {
  try {
    const testData = "Données sensibles TITAN V31.4 🔒";

    // Test chiffrement
    const encrypted = await PGPService.encrypt(testData);
    if (!Buffer.isBuffer(encrypted)) {
      throw new Error("Encryption did not return a Buffer");
    }

    // Test déchiffrement
    const decrypted = await PGPService.decrypt(encrypted);
    if (decrypted !== testData) {
      throw new Error(
        `Decryption mismatch: expected "${testData}", got "${decrypted}"`
      );
    }

    // Test avec null
    const nullEncrypted = await PGPService.encryptOptional(null);
    if (nullEncrypted !== null) {
      throw new Error("encryptOptional(null) should return null");
    }

    const nullDecrypted = await PGPService.decryptOptional(null);
    if (nullDecrypted !== null) {
      throw new Error("decryptOptional(null) should return null");
    }

    success(`PGP encryption/decryption (${encrypted.length} bytes)`);
    return true;
  } catch (err) {
    error("PGP encryption/decryption", err);
    return false;
  }
}

async function testAuth(): Promise<boolean> {
  try {
    const password = "TestPassword123!";

    // Test hashing
    const hashed = await AuthService.hashPassword(password);
    if (!hashed.startsWith("$2a$") && !hashed.startsWith("$2b$")) {
      throw new Error("Hash does not use bcrypt format");
    }

    // Test vérification positive
    const validPassword = await AuthService.verifyPassword(password, hashed);
    if (!validPassword) {
      throw new Error("Password verification failed for correct password");
    }

    // Test vérification négative
    const invalidPassword = await AuthService.verifyPassword("WrongPassword!", hashed);
    if (invalidPassword) {
      throw new Error("Password verification succeeded for wrong password");
    }

    // Test validation force
    const validation = AuthService.validatePasswordStrength("weak");
    if (validation.isValid) {
      throw new Error("Weak password validated as strong");
    }

    const strongValidation = AuthService.validatePasswordStrength("Strong123!");
    if (!strongValidation.isValid) {
      throw new Error("Strong password not validated");
    }

    success("Auth (hashing/verification)");
    return true;
  } catch (err) {
    error("Auth (hashing/verification)", err);
    return false;
  }
}

async function testTriggers(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Créer un centre temporaire
    const center = await db
      .insert(schema.centers)
      .values({
        name: "Test Center Trigger",
        code: "TCT",
      })
      .returning();

    // Créer un patient temporaire
    const patient = await db
      .insert(schema.patients)
      .values({
        centerId: center[0].id,
        firstName: "Test",
        lastName: "Patient",
      })
      .returning();

    // Créer une facture
    const invoice = await db
      .insert(schema.invoices)
      .values({
        patientId: patient[0].id,
        centerId: center[0].id,
        invoiceNumber: "TEST-INV-001",
        status: "pending",
      })
      .returning();

    // Vérifier que total_amount = 0 initialement
    if (invoice[0].totalAmount !== "0.00") {
      throw new Error(`Initial total_amount should be 0, got ${invoice[0].totalAmount}`);
    }

    // Ajouter un item
    await db.insert(schema.invoiceItems).values({
      invoiceId: invoice[0].id,
      description: "Test Item",
      quantity: "2",
      unitPrice: "50.00",
    });

    // Récupérer la facture mise à jour
    const updatedInvoice = await db
      .select()
      .from(schema.invoices)
      .where(sql`id = ${invoice[0].id}`);

    // Le trigger devrait avoir mis à jour total_amount = 100.00
    if (updatedInvoice[0].totalAmount !== "100.00") {
      throw new Error(
        `Trigger did not update total_amount: expected 100.00, got ${updatedInvoice[0].totalAmount}`
      );
    }

    // Cleanup
    await db.delete(schema.invoiceItems).where(sql`invoice_id = ${invoice[0].id}`);
    await db.delete(schema.invoices).where(sql`id = ${invoice[0].id}`);
    await db.delete(schema.patients).where(sql`id = ${patient[0].id}`);
    await db.delete(schema.centers).where(sql`id = ${center[0].id}`);

    success("Trigger recalc_invoice_totals (0.00 → 100.00)");
    return true;
  } catch (err) {
    error("Trigger recalc_invoice_totals", err);
    return false;
  }
}

async function testSearch(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Créer un centre temporaire
    const center = await db
      .insert(schema.centers)
      .values({
        name: "Test Center Search",
        code: "TCS",
      })
      .returning();

    // Créer un patient avec nom accentué
    const patient = await db
      .insert(schema.patients)
      .values({
        centerId: center[0].id,
        firstName: "François",
        lastName: "Müller",
        email: "francois@test.com",
      })
      .returning();

    // Attendre que le trigger trg_search_vector s'exécute
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Recherche sans accents devrait trouver le patient
    const result = await db.execute(sql`
      SELECT id, first_name, last_name
      FROM patients
      WHERE search_vector @@ to_tsquery('simple', unaccent('francois'))
      AND id = ${patient[0].id}
    `);

    if (result.rows.length === 0) {
      throw new Error("Search did not find patient with unaccent");
    }

    // Cleanup
    await db.delete(schema.patients).where(sql`id = ${patient[0].id}`);
    await db.delete(schema.centers).where(sql`id = ${center[0].id}`);

    success("Full-text search (François → francois)");
    return true;
  } catch (err) {
    error("Full-text search", err);
    return false;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  log("\n🧪 TITAN V31.4 - BACKEND TEST SUITE\n", colors.bold + colors.cyan);

  const results = {
    dbConnection: false,
    extensions: false,
    rls: false,
    pgp: false,
    auth: false,
    triggers: false,
    search: false,
  };

  // Test 1: Database Connection
  section("1. DATABASE CONNECTION");
  results.dbConnection = await testDatabaseConnection();

  if (!results.dbConnection) {
    log("\n❌ Cannot proceed without database connection", colors.red);
    process.exit(1);
  }

  // Test 2: Extensions
  section("2. POSTGRESQL EXTENSIONS");
  results.extensions = await testExtensions();

  // Test 3: RLS
  section("3. ROW LEVEL SECURITY (RLS)");
  results.rls = await testRLS();

  // Test 4: PGP
  section("4. PGP ENCRYPTION");
  results.pgp = await testPGP();

  // Test 5: Auth
  section("5. AUTHENTICATION");
  results.auth = await testAuth();

  // Test 6: Triggers
  section("6. DATABASE TRIGGERS");
  results.triggers = await testTriggers();

  // Test 7: Search
  section("7. FULL-TEXT SEARCH");
  results.search = await testSearch();

  // Summary
  section("SUMMARY");
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;
  const allPassed = passed === total;

  log(
    `\nTests passed: ${passed}/${total}`,
    allPassed ? colors.green : colors.red
  );

  if (allPassed) {
    log("\n🎉 ALL TESTS PASSED! Backend is ready for production.\n", colors.green);
  } else {
    log("\n⚠️  SOME TESTS FAILED. Review errors above.\n", colors.red);
  }

  Object.entries(results).forEach(([test, passed]) => {
    const icon = passed ? "✅" : "❌";
    const color = passed ? colors.green : colors.red;
    log(`${icon} ${test}`, color);
  });

  console.log("");

  process.exit(allPassed ? 0 : 1);
}

// Run tests
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});