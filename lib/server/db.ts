import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * One SQLite file, WAL mode, migrations versioned in `meta.schema_version`.
 *
 * ⚑ Every multi-row money or custody change goes through `tx()` (BEGIN
 *   IMMEDIATE), so a throw half-way leaves nothing behind. An HTTP call to the
 *   buyback partner must NEVER sit inside a `tx()` — it would hold the write
 *   lock for the round trip.
 * ⚑ New columns go in a NEW migration step; `CREATE TABLE IF NOT EXISTS` does
 *   not add columns to a table that already exists.
 */

const DB_PATH = process.env.SWAPUP_DB || join(process.cwd(), "data", "swapup.db");

type G = typeof globalThis & { __swapup_db?: Database.Database };
const g = globalThis as G;

export function db(): Database.Database {
  if (g.__swapup_db) return g.__swapup_db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  migrate(conn);
  g.__swapup_db = conn;
  return conn;
}

export function tx<T>(fn: () => T): T {
  return db().transaction(fn).immediate();
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

const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('platform','client','partner')),
    client_type TEXT,
    target_brand TEXT,
    partner_id TEXT REFERENCES orgs(id),
    settings TEXT NOT NULL DEFAULT '{}',
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE stores (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('service_center','experience_center','retail')),
    city TEXT,
    code TEXT NOT NULL,
    credit_limit INTEGER NOT NULL CHECK (credit_limit >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, code)
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    store_id TEXT REFERENCES stores(id),
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('platform','org_admin','store_manager','advisor','partner')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE trade_models (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    series TEXT,
    release_year INTEGER,
    support_end_year INTEGER,
    variants TEXT NOT NULL,
    service_tier TEXT NOT NULL DEFAULT 'other',
    care_plus_fee INTEGER,
    source TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE new_devices (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    series TEXT NOT NULL,
    variant TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    support_end_year INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE repair_book (
    org_id TEXT NOT NULL REFERENCES orgs(id),
    model_id TEXT NOT NULL,
    part TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    source TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (org_id, model_id, part)
  );
  CREATE TABLE rate_cards (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL REFERENCES orgs(id),
    data TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    data TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE cases (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    advisor_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    customer TEXT,
    model_id TEXT,
    variant TEXT,
    imei TEXT,
    imei_check TEXT,
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
    pickup_id TEXT,
    clearance TEXT,
    settled_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    locked_at TEXT,
    closed_at TEXT
  );
  CREATE INDEX cases_store_status ON cases (store_id, status);
  CREATE INDEX cases_imei ON cases (imei);
  CREATE INDEX cases_pickup ON cases (pickup_id);
  CREATE TABLE credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL REFERENCES stores(id),
    case_id TEXT NOT NULL REFERENCES cases(id),
    kind TEXT NOT NULL CHECK (kind IN ('hold','release','chargeback','recovery')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT,
    by_user TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX ledger_store ON credit_ledger (store_id, id);
  CREATE INDEX ledger_case ON credit_ledger (case_id);
  CREATE TABLE pickups (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    partner_id TEXT NOT NULL REFERENCES orgs(id),
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
  CREATE INDEX pickups_store ON pickups (store_id, status);
  CREATE TABLE audit (
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
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `,
  /* 2 — second IMEI (dual-SIM phones carry two; a block on one is evaded by
         presenting the other) and the reason a case was closed. */ `
  ALTER TABLE cases ADD COLUMN imei2 TEXT;
  ALTER TABLE cases ADD COLUMN imei2_check TEXT;
  ALTER TABLE cases ADD COLUMN closed_reason TEXT;
  CREATE INDEX cases_imei2 ON cases (imei2);
  `,
  /* 3 — SwapUp Check: customer test sessions on their own phone, store Wi-Fi,
         Samsung model codes for matching, one-time web hand-off nonces. */ `
  CREATE TABLE test_sessions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    case_id TEXT NOT NULL REFERENCES cases(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    plan TEXT NOT NULL,
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
    updated_at TEXT NOT NULL
  );
  CREATE INDEX test_sessions_code ON test_sessions (code);
  CREATE INDEX test_sessions_ticket ON test_sessions (ticket_hash);
  CREATE INDEX test_sessions_store ON test_sessions (store_id, status);
  ALTER TABLE stores ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE trade_models ADD COLUMN model_codes TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE handoff_nonces (
    nonce_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    next TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
  /* 4 — self-serve sign-up: stores register themselves (pending until the
         programme approves and sets a credit line), staff join with an invite. */ `
  ALTER TABLE stores ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE stores ADD COLUMN registered_by TEXT;
  ALTER TABLE stores ADD COLUMN review_note TEXT;
  CREATE TABLE store_invites (
    code_hash TEXT PRIMARY KEY,
    code_hint TEXT NOT NULL,
    store_id TEXT NOT NULL REFERENCES stores(id),
    role TEXT NOT NULL CHECK (role IN ('advisor','store_manager')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT
  );
  CREATE INDEX store_invites_store ON store_invites (store_id);
  `,
];

function migrate(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = conn.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version];
    conn.transaction(() => {
      conn.exec(step);
      conn.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        String(version + 1)
      );
    })();
    version += 1;
  }
}

/** Monotonic human-readable sequence per name (case refs, pickup refs). */
export function nextSeq(name: string): number {
  const conn = db();
  conn.prepare(`INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING`).run(name);
  conn.prepare(`UPDATE counters SET value = value + 1 WHERE name = ?`).run(name);
  return (conn.prepare(`SELECT value FROM counters WHERE name = ?`).get(name) as { value: number }).value;
}

export function audit(entry: {
  userId?: string | null;
  orgId?: string | null;
  storeId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}): void {
  db()
    .prepare(`INSERT INTO audit (at, user_id, org_id, store_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      nowIso(),
      entry.userId ?? null,
      entry.orgId ?? null,
      entry.storeId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail)
    );
}
