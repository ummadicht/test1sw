import { Pool, type QueryResultRow, type PoolClient } from "pg";
import { randomBytes } from "node:crypto";

/**
 * PostgreSQL Persistence Layer for SwapUp.
 *
 * Exclusively connects to PostgreSQL and targets the 'swapup' schema.
 * Replaces SQLite entirely for all data access across API routes and server pages.
 */

type G = typeof globalThis & {
  __swapup_pg_pool?: Pool;
};
const g = globalThis as G;

export function getPool(): Pool {
  if (!g.__swapup_pg_pool) {
    const connectionString = process.env.DATABASE_URL;
    const schema = process.env.PGSCHEMA || "swapup";

    if (connectionString) {
      g.__swapup_pg_pool = new Pool({
        connectionString,
        options: `-c search_path=${schema},public`,
      });
    } else {
      g.__swapup_pg_pool = new Pool({
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT) || 5432,
        database: process.env.PGDATABASE || "scrapingdb",
        user: process.env.PGUSER || "guru_user",
        password: process.env.PGPASSWORD || "",
        options: `-c search_path=${schema},public`,
      });
    }

    g.__swapup_pg_pool.on("error", (err) => {
      console.error("[SwapUp PostgreSQL Pool Error]", err);
    });
  }
  return g.__swapup_pg_pool;
}

export function toPgSql(sql: string): string {
  let paramIdx = 1;
  let out = sql.replace(/\?/g, () => `$${paramIdx++}`);
  // json_extract(col, '$.a.b') -> (col::jsonb #>> '{a,b}')
  out = out.replace(/json_extract\(\s*([^,]+)\s*,\s*'\$\.([^']+)'\s*\)/gi, (_m, col, path) => {
    const parts = path.split(".").join(",");
    return `(${col}::jsonb #>> '{${parts}}')`;
  });
  // json_valid(col) -> (col IS NOT NULL AND col != '')
  out = out.replace(/json_valid\(\s*([^)]+)\s*\)/gi, "($1 IS NOT NULL AND $1 != '')");
  // remove COLLATE NOCASE
  out = out.replace(/=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, "ILIKE $1");
  out = out.replace(/\s+COLLATE\s+NOCASE/gi, "");
  return out;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  const res = await pool.query<T>(toPgSql(text), params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const pool = getPool();
  const res = await pool.query<T>(toPgSql(text), params);
  return res.rows[0] ?? null;
}

export async function execute(
  text: string,
  params: unknown[] = []
): Promise<{ rowCount: number }> {
  const pool = getPool();
  const res = await pool.query(toPgSql(text), params);
  return { rowCount: res.rowCount ?? 0 };
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T> | T): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return nowIso().slice(0, 10);
}

/** Short, unguessable ids — 12 bytes of entropy, url-safe. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Monotonic human-readable sequence per name (case refs, pickup refs). */
export async function nextSeq(name: string): Promise<number> {
  const row = await queryOne<{ value: string | number }>(
    `INSERT INTO counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [name]
  );
  return Number(row?.value || 1);
}

export async function audit(entry: {
  userId?: string | null;
  orgId?: string | null;
  storeId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}): Promise<void> {
  await execute(
    `INSERT INTO audit (at, user_id, org_id, store_id, action, entity, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      nowIso(),
      entry.userId ?? null,
      entry.orgId ?? null,
      entry.storeId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ]
  );
}

/** Legacy migration list retained for specification compatibility. */
export const MIGRATIONS: readonly string[] = [];
