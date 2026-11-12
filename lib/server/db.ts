import { Pool, type QueryResultRow, type PoolClient } from "pg";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistence Layer for SwapUp.
 *
 * Uses Node's built-in SQLite (node:sqlite DatabaseSync) by default when DATABASE_URL is not set,
 * or PostgreSQL when DATABASE_URL is configured.
 */

export type SqliteStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
};

export type SqliteCompatDb = {
  exec: (sql: string) => void;
  pragma: (pragmaStr: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  raw: DatabaseSync;
};

export const MIGRATIONS: readonly string[] = [
  "001_initial_schema",
  "002_store_tablet_and_pins",
  "003_test_sessions_and_diagnostics",
  "004_gradeiq_bridge",
  "005_store_onboarding_and_invites",
  "006_market_listings",
  "007_camera_check_and_fault_sources",
  "008_data_clear_and_refurb_cost",
  "009_storage_variants_and_measured_storage",
  "010_counter_code_and_phone_phase",
  "011_certification_and_grading_reports",
  "012_phonecheck_integration",
  "013_imei_lookup_and_kym_early",
  "014_model_codes_and_model_source",
  "015_scan_release",
  "016_catalogue_source",
  "017_gradeiq_devicefax",
];

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_type TEXT,
  target_brand TEXT,
  partner_id TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  city TEXT,
  code TEXT NOT NULL,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  review_note TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  registered_by TEXT,
  counter_code TEXT,
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  store_id TEXT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  pin_hash TEXT,
  pin_set_at TEXT
);

CREATE TABLE IF NOT EXISTS trade_models (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  series TEXT,
  release_year INTEGER,
  support_end_year INTEGER,
  variants TEXT NOT NULL DEFAULT '[]',
  service_tier TEXT NOT NULL DEFAULT 'other',
  care_plus_fee INTEGER,
  model_codes TEXT NOT NULL DEFAULT '[]',
  source TEXT
);

CREATE TABLE IF NOT EXISTS new_devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  series TEXT NOT NULL,
  variant TEXT NOT NULL,
  price INTEGER NOT NULL,
  support_end_year INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100,
  source TEXT
);

CREATE TABLE IF NOT EXISTS repair_book (
  org_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  part TEXT NOT NULL,
  price INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (org_id, model_id, part)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  data TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_cards (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  data TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  advisor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  customer TEXT,
  model_id TEXT,
  variant TEXT,
  imei TEXT,
  imei_check TEXT,
  imei2 TEXT,
  imei2_check TEXT,
  closed_reason TEXT,
  faults TEXT NOT NULL DEFAULT '[]',
  coverage TEXT NOT NULL DEFAULT 'none',
  condition TEXT,
  manual_repair TEXT,
  partner_manual TEXT,
  repair TEXT,
  quote TEXT,
  repaired_quote TEXT,
  upgrade TEXT,
  bonus TEXT,
  decision TEXT,
  checks TEXT,
  trade_value INTEGER,
  bonus_value INTEGER,
  payable INTEGER,
  premium_value INTEGER,
  premium_bp INTEGER,
  premium_funded_by TEXT,
  pickup_id TEXT,
  clearance TEXT,
  settled_at TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT,
  closed_at TEXT,
  fault_sources TEXT NOT NULL DEFAULT '{}',
  camera_check TEXT,
  data_clear TEXT,
  refurb_cost TEXT,
  variant_source TEXT,
  storage_quotes TEXT,
  measured_storage TEXT,
  certification TEXT,
  report_token TEXT,
  imei_lookup TEXT,
  kym_early TEXT,
  model_source TEXT
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  by_user TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickups (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT,
  requested_at TEXT NOT NULL,
  scheduled_for TEXT,
  collector_name TEXT,
  handover_by TEXT,
  collected_at TEXT,
  reconciled_at TEXT,
  settled_at TEXT,
  settlement_ref TEXT,
  settlement_amount INTEGER,
  notes TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  org_id TEXT,
  store_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS test_sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  case_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '[]',
  install_id TEXT,
  ticket_hash TEXT,
  device TEXT,
  declared TEXT,
  results TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  joined_at TEXT,
  completed_at TEXT,
  applied_at TEXT,
  updated_at TEXT NOT NULL,
  gradeiq_id TEXT,
  gradeiq_state TEXT NOT NULL DEFAULT 'disabled',
  gradeiq_error TEXT,
  gradeiq_snapshot TEXT,
  gradeiq_synced_at TEXT,
  gradeiq_forwarded_at TEXT,
  gradeiq_attempts INTEGER NOT NULL DEFAULT 0,
  gradeiq_orphans TEXT NOT NULL DEFAULT '[]',
  gradeiq_screen TEXT,
  gradeiq_screen_at TEXT,
  gradeiq_cosmetic_done_at TEXT,
  gradeiq_device_hash TEXT,
  gradeiq_forward_hash TEXT,
  gradeiq_sync_error TEXT,
  gradeiq_override TEXT,
  gradeiq_devicefax TEXT,
  phone_phase TEXT,
  phone_phase_at TEXT,
  started_via TEXT,
  scan_release TEXT
);

CREATE TABLE IF NOT EXISTS handoff_nonces (
  nonce_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  next TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS store_invites (
  code_hash TEXT PRIMARY KEY,
  code_hint TEXT NOT NULL,
  store_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 5,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS store_devices (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE TABLE IF NOT EXISTS pin_attempts (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_failure_at TEXT,
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE IF NOT EXISTS market_listings (
  source TEXT NOT NULL,
  model_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  grade TEXT NOT NULL,
  price INTEGER NOT NULL,
  week TEXT NOT NULL,
  listed_as TEXT,
  fetched_at TEXT,
  observed_at TEXT,
  points INTEGER
);

CREATE TABLE IF NOT EXISTS grading_reports (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ruleset TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  photo_sources TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL,
  issued_by TEXT,
  UNIQUE(case_id, version)
);

CREATE TABLE IF NOT EXISTS phonecheck_records (
  id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  imei TEXT,
  imei2 TEXT,
  store_id TEXT,
  case_id TEXT,
  tested_at TEXT,
  record TEXT NOT NULL,
  raw TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attached_at TEXT,
  attached_by TEXT,
  attach_override TEXT
);

CREATE TABLE IF NOT EXISTS razorpay_payments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  case_ref TEXT NOT NULL,
  org_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  journey TEXT NOT NULL,
  payment_plan TEXT NOT NULL,
  installment_stage TEXT NOT NULL,
  total_case_payable INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  remaining_due INTEGER NOT NULL DEFAULT 0,
  emi_months INTEGER,
  emi_monthly_amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'INR',
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  customer_name TEXT,
  customer_phone TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_case_id ON razorpay_payments(case_id);
`;

type G = typeof globalThis & {
  __swapup_pg_pool?: Pool;
  __swapup_pg_init?: Promise<void>;
  __swapup_sqlite_db?: SqliteCompatDb;
  __swapup_sqlite_path?: string;
};
const g = globalThis as G;

function usePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.PGHOST);
}

export function db(): SqliteCompatDb {
  const targetPath = process.env.SWAPUP_DB || path.join(process.cwd(), "data", "swapup.db");
  if (!g.__swapup_sqlite_db || g.__swapup_sqlite_path !== targetPath) {
    if (g.__swapup_sqlite_db) {
      try {
        g.__swapup_sqlite_db.close();
      } catch {
        // ignore close error on previous handle
      }
    }
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const raw = new DatabaseSync(targetPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.exec(SQLITE_SCHEMA);

    const compat: SqliteCompatDb = {
      raw,
      exec: (sql: string) => raw.exec(sql),
      pragma: (pragmaStr: string) => raw.exec(`PRAGMA ${pragmaStr}`),
      close: () => raw.close(),
      prepare: (sql: string): SqliteStatement => {
        const stmt = raw.prepare(sql);
        return {
          all: (...params: unknown[]) => {
            const bound = params.map(normalizeSqliteParam) as (string | number | bigint | Uint8Array | null)[];
            return (stmt.all(...bound) as Record<string, unknown>[]).map((r) => ({ ...r }));
          },
          get: (...params: unknown[]) => {
            const bound = params.map(normalizeSqliteParam) as (string | number | bigint | Uint8Array | null)[];
            const r = stmt.get(...bound) as Record<string, unknown> | undefined;
            return r ? { ...r } : undefined;
          },
          run: (...params: unknown[]) => {
            const bound = params.map(normalizeSqliteParam) as (string | number | bigint | Uint8Array | null)[];
            const res = stmt.run(...bound);
            return {
              changes: Number(res.changes ?? 0),
              lastInsertRowid: res.lastInsertRowid,
            };
          },
        };
      },
    };
    g.__swapup_sqlite_db = compat;
    g.__swapup_sqlite_path = targetPath;
  }
  return g.__swapup_sqlite_db;
}

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

function ensurePgSchema(): Promise<void> {
  if (!g.__swapup_pg_init) {
    g.__swapup_pg_init = (async () => {
      const pool = getPool();
      const rawSchema = process.env.PGSCHEMA || "swapup";
      const safeSchema = rawSchema.replace(/[^a-zA-Z0-9_]/g, "") || "swapup";
      const pgDdl = SQLITE_SCHEMA.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${safeSchema}"`);
      await pool.query(pgDdl);
    })();
  }
  return g.__swapup_pg_init;
}

export function toPgSql(sql: string): string {
  let paramIdx = 1;
  let out = sql.replace(/\?/g, () => `$${paramIdx++}`);
  // json_extract(col, '$.a.b') -> (col::jsonb #>> '{a,b}')
  out = out.replace(/json_extract\(\s*([^,]+)\s*,\s*'\$\.([^']+)'\s*\)/gi, (_m, col, p) => {
    const parts = p.split(".").join(",");
    return `(${col}::jsonb #>> '{${parts}}')`;
  });
  // json_valid(col) -> (col IS NOT NULL AND col != '')
  out = out.replace(/json_valid\(\s*([^)]+)\s*\)/gi, "($1 IS NOT NULL AND $1 != '')");
  // remove COLLATE NOCASE
  out = out.replace(/=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, "ILIKE $1");
  out = out.replace(/\s+COLLATE\s+NOCASE/gi, "");
  return out;
}

function normalizeSqliteParam(val: unknown): unknown {
  if (val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "object" && val !== null && !Buffer.isBuffer(val) && !ArrayBuffer.isView(val)) {
    return JSON.stringify(val);
  }
  return val;
}

export function toSqliteSql(sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
  const trimmed = sql.trim();
  if (/^SET\s+CONSTRAINTS\s+ALL\s+DEFERRED/i.test(trimmed)) {
    return { sql: "PRAGMA defer_foreign_keys = ON", params: [] };
  }

  let out = sql;

  // to_char(c.locked_at::timestamptz + interval '330 minutes', 'YYYY-MM') -> strftime('%Y-%m', c.locked_at, '+330 minutes')
  out = out.replace(
    /to_char\(\s*([^:]+)::timestamptz\s*\+\s*interval\s*'330 minutes'\s*,\s*'YYYY-MM'\s*\)/gi,
    "strftime('%Y-%m', $1, '+330 minutes')"
  );

  // position($3 in detail) -> instr(detail, $3)
  out = out.replace(/position\(\s*(\$\d+|\?)\s+in\s+([^)]+)\)/gi, "instr($2, $1)");

  // (col::jsonb #>> '{a,b}') -> json_extract(col, '$.a.b')
  out = out.replace(/\(?([a-zA-Z0-9_.]+)(?:::jsonb)?\s*#>>\s*'\{([^}]+)\}'\)?/gi, (_m, col, jsonPath: string) => {
    const dotted = jsonPath
      .split(",")
      .map((s) => s.trim())
      .join(".");
    return `json_extract(${col}, '$.${dotted}')`;
  });

  // (col::jsonb->>'key') or (col::jsonb ->> 'key') -> json_extract(col, '$.key')
  out = out.replace(/\(?([a-zA-Z0-9_.]+)(?:::jsonb)?\s*->>\s*'([^']+)'\)?/gi, "json_extract($1, '$.$2')");

  // Strip PostgreSQL type casts
  out = out.replace(/::text\[\]/gi, "");
  out = out.replace(/::(int|integer|numeric|text|jsonb|timestamptz)\b/gi, "");

  // ILIKE -> LIKE
  out = out.replace(/\bILIKE\b/gi, "LIKE");

  // If query uses $1, $2 placeholders (or = ANY($N)), expand in left-to-right appearance order
  if (/(\$\d+)/.test(out)) {
    const bound: unknown[] = [];
    out = out.replace(/=\s*ANY\(\s*\$(\d+)\s*\)|\$(\d+)/gi, (_match, anyIdx: string | undefined, paramIdx: string | undefined) => {
      if (anyIdx !== undefined) {
        const arr = params[Number(anyIdx) - 1];
        if (Array.isArray(arr)) {
          if (arr.length === 0) return "IN (NULL)";
          for (const item of arr) {
            bound.push(normalizeSqliteParam(item));
          }
          return `IN (${arr.map(() => "?").join(", ")})`;
        }
        bound.push(normalizeSqliteParam(arr));
        return "= ?";
      }
      const val = params[Number(paramIdx) - 1];
      bound.push(normalizeSqliteParam(val));
      return "?";
    });
    return { sql: out, params: bound };
  }

  return { sql: out, params: params.map(normalizeSqliteParam) };
}

function runSqliteQuery<T>(text: string, params: unknown[] = []): { rows: T[]; rowCount: number } {
  const sqlite = db();
  const { sql, params: bound } = toSqliteSql(text, params);
  const trimmed = sql.trim();
  if (/^PRAGMA\b/i.test(trimmed)) {
    sqlite.exec(trimmed);
    return { rows: [], rowCount: 0 };
  }
  const stmt = sqlite.prepare(sql);
  const isReader = /^\s*(SELECT|WITH)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed);
  if (isReader) {
    const rows = stmt.all(...bound) as T[];
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...bound);
  return { rows: [], rowCount: info.changes };
}

const txContext = new AsyncLocalStorage<{ depth: number; pgClient?: PoolClient }>();
let sqliteTxChain: Promise<unknown> = Promise.resolve();

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  if (usePostgres()) {
    await ensurePgSchema();
    const activeClient = txContext.getStore()?.pgClient;
    const runner = activeClient ?? getPool();
    const res = await runner.query<T>(toPgSql(text), params);
    return res.rows;
  }
  return runSqliteQuery<T>(text, params).rows;
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  if (usePostgres()) {
    await ensurePgSchema();
    const activeClient = txContext.getStore()?.pgClient;
    const runner = activeClient ?? getPool();
    const res = await runner.query<T>(toPgSql(text), params);
    return res.rows[0] ?? null;
  }
  const rows = runSqliteQuery<T>(text, params).rows;
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  params: unknown[] = []
): Promise<{ rowCount: number }> {
  if (usePostgres()) {
    await ensurePgSchema();
    const activeClient = txContext.getStore()?.pgClient;
    const runner = activeClient ?? getPool();
    const res = await runner.query(toPgSql(text), params);
    return { rowCount: res.rowCount ?? 0 };
  }
  const { rowCount } = runSqliteQuery(text, params);
  return { rowCount };
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T> | T): Promise<T> {
  if (usePostgres()) {
    await ensurePgSchema();
    const current = txContext.getStore();
    if (current?.pgClient) {
      const sp = `sp_${current.depth + 1}`;
      await current.pgClient.query(`SAVEPOINT ${sp}`);
      try {
        const result = await txContext.run({ depth: current.depth + 1, pgClient: current.pgClient }, () => fn(current.pgClient!));
        await current.pgClient.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await current.pgClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await current.pgClient.query(`RELEASE SAVEPOINT ${sp}`);
        throw err;
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await txContext.run({ depth: 1, pgClient: client }, () => fn(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const sqlite = db();
  const mockClient = {
    query: async <R extends QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const { rows, rowCount } = runSqliteQuery<R>(text, params);
      return { rows, rowCount };
    },
    release: () => {},
  } as unknown as PoolClient;

  const current = txContext.getStore();
  if (current) {
    const sp = `sp_${current.depth + 1}`;
    sqlite.exec(`SAVEPOINT ${sp}`);
    try {
      const res = await txContext.run({ depth: current.depth + 1 }, () => fn(mockClient));
      sqlite.exec(`RELEASE SAVEPOINT ${sp}`);
      return res;
    } catch (err) {
      sqlite.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      sqlite.exec(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  }

  const runTopLevel = async (): Promise<T> => {
    sqlite.exec("BEGIN");
    try {
      const res = await txContext.run({ depth: 1 }, () => fn(mockClient));
      sqlite.exec("COMMIT");
      return res;
    } catch (err) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        // ignore if already rolled back
      }
      throw err;
    }
  };

  const next = sqliteTxChain.then(runTopLevel, runTopLevel);
  sqliteTxChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
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

