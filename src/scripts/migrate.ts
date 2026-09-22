/**
 * Database migration runner.
 *
 * Usage:
 *   npm run migrate                 — apply pending migrations
 *   npm run migrate -- --status     — show applied/pending migrations
 *   npm run migrate -- --baseline   — mark all current migrations as applied
 *                                     (for existing databases created by hand)
 *
 * Migrations are applied in filename order and recorded in
 * `schema_migrations`, making replays from a clean database reproducible.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mysql, { RowDataPacket } from "mysql2/promise";

// Works for both src (ts-node) and dist (compiled) locations.
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "database", "migrations");

interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: Record<string, unknown>;
}

function connectionConfig(): ConnectionConfig {
  const sslDisabled = process.env.DB_SSL === "false";
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USERNAME ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_DATABASE ?? "lms",
    ssl: sslDisabled ? undefined : {},
  };
}

function readMigrations(): { name: string; filePath: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file: string) => file.endsWith(".sql"))
    .sort()
    .map((file: string) => ({ name: file, filePath: path.join(MIGRATIONS_DIR, file) }));
}

/** Split a SQL file into individual statements, ignoring comment-only blocks. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => {
      const withoutComments = statement
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      return withoutComments.length > 0;
    });
}

/**
 * MySQL/TiDB error codes that represent an idempotent no-op — the object the
 * migration creates (or drops) is already in the desired state. Replaying the
 * full history against an existing database should not fail on these, so we
 * log and continue rather than abort. Anything else is a genuine error.
 */
const IDEMPOTENT_ERROR_CODES = new Set([
  "ER_TABLE_EXISTS_ERROR", // 1050 CREATE TABLE when the table exists
  "ER_DUP_FIELDNAME",      // 1060 ADD COLUMN when the column exists
  "ER_DUP_KEYNAME",        // 1061 CREATE/ADD INDEX when the index exists
  "ER_DUP_ENTRY",          // 1062 inserting an existing unique row
  "ER_CANT_DROP_FIELD_OR_KEY", // 1091 DROP COLUMN/INDEX when already gone
  "ER_FK_DUP_NAME",        // 1826 ADD CONSTRAINT when the FK name already exists
]);

function isIdempotentNoOp(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" && IDEMPOTENT_ERROR_CODES.has(code);
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--status")
    ? "status"
    : process.argv.includes("--baseline")
      ? "baseline"
      : "migrate";

  const connection = await mysql.createConnection(connectionConfig());

  try {
    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (name)
      )`,
    );

    const [appliedRows] = await connection.query<RowDataPacket[]>(
      "SELECT name FROM schema_migrations",
    );
    const applied = new Set(appliedRows.map((row) => String(row.name)));
    const migrations = readMigrations();

    if (mode === "status") {
      for (const migration of migrations) {
        console.log(`${applied.has(migration.name) ? "[x]" : "[ ]"} ${migration.name}`);
      }
      return;
    }

    if (mode === "baseline") {
      for (const migration of migrations) {
        if (!applied.has(migration.name)) {
          await connection.query(
            "INSERT INTO schema_migrations (name) VALUES (?)",
            [migration.name],
          );
          console.log(`baselined ${migration.name}`);
        }
      }
      console.log("Baseline complete. Future runs will only apply new migrations.");
      return;
    }

    let count = 0;
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      const sql = fs.readFileSync(migration.filePath, "utf8");
      const statements = splitStatements(sql);
      console.log(`applying ${migration.name} (${statements.length} statement(s))...`);
      for (const statement of statements) {
        try {
          await connection.query(statement);
        } catch (error) {
          // Tolerate "already exists"/"already dropped" so the whole history can
          // be replayed against an existing database without a fragile baseline.
          if (isIdempotentNoOp(error)) {
            console.warn(
              `  ! skipped (already applied): ${(error as Error).message}`,
            );
            continue;
          }
          console.error(`\nFailed on statement:\n${statement}\n`);
          throw error;
        }
      }
      await connection.query(
        "INSERT INTO schema_migrations (name) VALUES (?)",
        [migration.name],
      );
      count += 1;
      console.log(`applied  ${migration.name}`);
    }
    console.log(
      count === 0
        ? "Database is up to date — no pending migrations."
        : `Done. ${count} migration(s) applied.`,
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Migration run failed:", error);
  process.exit(1);
});
