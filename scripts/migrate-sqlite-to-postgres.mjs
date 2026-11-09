/**
 * SwapUp Engine: SQLite to PostgreSQL Migration Script
 * ====================================================
 * Migrates all 22 SwapUp domain tables from SQLite (data/swapup.db)
 * directly into the dedicated PostgreSQL 'swapup' schema.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.mjs [--sqlite-path <path>]
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

const { Pool } = pg;

const sqlitePath = process.argv[3] || process.env.SWAPUP_DB || path.join(process.cwd(), "data", "swapup.db");
console.log(`[SwapUp] Reading from SQLite database: ${sqlitePath}`);

const pgConfig = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "scrapingdb",
  user: process.env.PGUSER || "guru_user",
  password: process.env.PGPASSWORD || "Scrap@2026chtGuru",
};

async function migrate() {
  console.log(`[SwapUp] Connecting to PostgreSQL (${pgConfig.user}@${pgConfig.host}:${pgConfig.port}/${pgConfig.database})...`);
  const pool = new Pool(pgConfig);
  const client = await pool.connect();

  try {
    // Ensure we operate exclusively within the swapup schema
    await client.query("CREATE SCHEMA IF NOT EXISTS swapup;");
    await client.query("SET search_path TO swapup, public;");
    console.log("[SwapUp] Successfully locked search_path to 'swapup'.");

    if (!fs.existsSync(sqlitePath)) {
      console.log(`[SwapUp] Notice: SQLite file not found at ${sqlitePath}. PostgreSQL schema 'swapup' is provisioned and ready.`);
      return;
    }

    const sdb = new Database(sqlitePath, { readonly: true });
    const tables = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    console.log(`[SwapUp] Found tables in SQLite: ${tables.join(", ")}`);

    for (const table of tables) {
      const rows = sdb.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`[SwapUp] Table '${table}' has 0 rows in SQLite. Skipping.`);
        continue;
      }

      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

      const insertSql = `INSERT INTO swapup."${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING;`;
      let inserted = 0;

      for (const row of rows) {
        const values = cols.map((c) => row[c]);
        const res = await client.query(insertSql, values);
        inserted += res.rowCount || 0;
      }

      console.log(`[SwapUp] Migrated '${table}': ${rows.length} rows read, ${inserted} inserted into PostgreSQL swapup.${table}.`);
    }

    console.log("[SwapUp] Migration completed successfully!");
  } catch (err) {
    console.error("[SwapUp] Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
