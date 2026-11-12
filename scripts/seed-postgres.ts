import fs from "node:fs";
import path from "node:path";
import seedData from "../lib/server/seed-data.json";
import { hashPassword, orgSettingsDefaults } from "../lib/server/auth";
import {
  buildSamsungAppleRateCardObject,
  buildCompleteRepairBook,
  buildDeviceRepairCostsCsv,
} from "../lib/server/defaultRateCard";
import { getPool } from "../lib/server/db";
import { ensureSeeded } from "../lib/server/seed";

type SeedData = {
  observedAt: string;
  tradeModels: {
    id: string;
    brand: string;
    model: string;
    series: string | null;
    releaseYear: number;
    supportEndYear: number | null;
    variants: string[];
    serviceTier: string;
    carePlusFee: number | null;
    modelCodes?: string[];
    source: unknown;
  }[];
  repairBook: { modelId: string; part: string; price: number; source: unknown }[];
  newDevices: {
    brand: string;
    model: string;
    series: string;
    variant: string;
    price: number;
    supportEndYear: number | null;
    sort: number;
    source: unknown;
  }[];
};

const DATA = seedData as SeedData;

function pgLit(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "1" : "0";
  const str = typeof val === "string" ? val : JSON.stringify(val);
  return `'${str.replace(/'/g, "''")}'`;
}

export function generatePostgresSeedSql(): string {
  const now = "2026-11-12T00:00:00.000Z";
  const today = "2026-11-12";
  const pwHash = hashPassword(process.env.SWAPUP_DEMO_PASSWORD || "swapup2026");
  const completeRepairBook = buildCompleteRepairBook();

  const lines: string[] = [];
  lines.push("-- =============================================================================");
  lines.push("-- SwapUp — Complete PostgreSQL Schema (20 Tables incl. Razorpay) + Catalogue +");
  lines.push("--          Samsung & Apple Rate Cards (290 rows) + Device Repair Costs (1,520 rows/org)");
  lines.push("-- Run with: psql \"$DATABASE_URL\" -f deploy/postgres-full-seed.sql");
  lines.push("--       or: psql -h 127.0.0.1 -U guru_user -d scrapingdb -f deploy/postgres-full-seed.sql");
  lines.push("-- =============================================================================");
  lines.push("");
  lines.push("BEGIN;");
  lines.push("CREATE SCHEMA IF NOT EXISTS swapup;");
  lines.push("SET search_path TO swapup, public;");
  lines.push("");

  lines.push(`
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
`.trim());

  lines.push("");
  lines.push("-- 1. Organisations");
  const s1 = JSON.stringify({ ...orgSettingsDefaults(), releaseOn: "collected" });
  const s2 = JSON.stringify({ ...orgSettingsDefaults(), releaseOn: "cleared", maxAgeDays: 5 });
  const sDef = JSON.stringify(orgSettingsDefaults());

  const orgs = [
    ["org_platform", "SwapUp", "platform", null, null, null, "{}", 0, now],
    ["ptn_demo", "Buyback Partner (demo)", "partner", null, null, null, "{}", 1, now],
    ["ptn_BfpxCIbbL6RTGPMk", "Buyback partner", "partner", null, null, null, sDef, 0, now],
    ["org_samsung_svc", "SwapUp Experience Centers (demo)", "client", "oem_service", "Samsung", "ptn_demo", s1, 1, now],
    ["org_xc", "Any Client — Experience Centres (demo)", "client", "experience_center", "Samsung", "ptn_demo", s2, 1, now],
    ["org_lclf4XEbw-IpMyJt", "SwapUp Experience Centres", "client", "experience_center", "Samsung", "ptn_BfpxCIbbL6RTGPMk", sDef, 0, now],
  ];

  for (const o of orgs) {
    lines.push(
      `INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, demo, created_at) VALUES (${o.map(pgLit).join(", ")}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, partner_id = EXCLUDED.partner_id;`
    );
  }

  lines.push("");
  lines.push("-- 2. Stores (unique store codes across all programmes)");
  const stores = [
    ["st_and", "org_samsung_svc", "Andheri West Experience Center", "service_center", "Mumbai", "AND", 300000, now],
    ["st_kor", "org_samsung_svc", "Koramangala Experience Center", "service_center", "Bengaluru", "KOR", 95000, now],
    ["st_cpx", "org_xc", "Connaught Place Experience Centre", "experience_center", "New Delhi", "CPX", 500000, now],
    ["st_bdr", "org_lclf4XEbw-IpMyJt", "Bandra Kurla Experience Centre", "experience_center", "Mumbai", "BDR", 500000, now],
  ];
  for (const s of stores) {
    lines.push(
      `INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at) VALUES (${s.map(pgLit).join(", ")}) ON CONFLICT (id) DO NOTHING;`
    );
  }

  lines.push("");
  lines.push("-- 3. Users (default password: swapup2026)");
  const users = [
    ["usr_platform", "org_platform", null, "platform", "SwapUp Ops", "platform", pwHash, now],
    ["usr_partner", "ptn_demo", null, "partner", "Partner Ops (demo)", "partner", pwHash, now],
    ["usr_24G2U2zS1l-B6bF_", "ptn_BfpxCIbbL6RTGPMk", null, "buyback.partner", "Buyback Partner", "partner", pwHash, now],
    ["usr_samsung", "org_samsung_svc", null, "samsung", "Programme Admin (demo)", "org_admin", pwHash, now],
    ["usr_mgr_and", "org_samsung_svc", "st_and", "manager", "Priya Nair", "store_manager", pwHash, now],
    ["usr_adv_and", "org_samsung_svc", "st_and", "advisor", "Rahul Desai", "advisor", pwHash, now],
    ["usr_mgr_kor", "org_samsung_svc", "st_kor", "manager.kor", "Kiran Rao", "store_manager", pwHash, now],
    ["usr_adv_kor", "org_samsung_svc", "st_kor", "advisor.kor", "Divya Shetty", "advisor", pwHash, now],
    ["usr_xc_admin", "org_xc", null, "xc.admin", "Experience Admin (demo)", "org_admin", pwHash, now],
    ["usr_xc_mgr", "org_xc", "st_cpx", "xc.manager", "Arjun Mehta", "store_manager", pwHash, now],
    ["usr_xc_adv", "org_xc", "st_cpx", "xc.advisor", "Sana Qureshi", "advisor", pwHash, now],
  ];
  for (const u of users) {
    lines.push(
      `INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (${u.map(pgLit).join(", ")}) ON CONFLICT (id) DO NOTHING;`
    );
  }

  lines.push("");
  lines.push(`-- 4. Trade Models (${DATA.tradeModels.length} models including all Samsung & Apple phones)`);
  for (const m of DATA.tradeModels) {
    lines.push(
      `INSERT INTO trade_models (id, brand, model, series, release_year, support_end_year, variants, service_tier, care_plus_fee, model_codes, source) VALUES (${[
        m.id,
        m.brand,
        m.model,
        m.series,
        m.releaseYear,
        m.supportEndYear,
        JSON.stringify(m.variants),
        m.serviceTier,
        m.carePlusFee,
        JSON.stringify(m.modelCodes ?? []),
        JSON.stringify(m.source),
      ]
        .map(pgLit)
        .join(", ")}) ON CONFLICT (id) DO UPDATE SET variants = EXCLUDED.variants, model_codes = EXCLUDED.model_codes;`
    );
  }

  lines.push("");
  lines.push(
    `-- 5. Complete Device-Specific Repair Book (${completeRepairBook.length} rows per programme across all 10 parts) & New Upgrade Devices`
  );
  const clientOrgs = ["org_samsung_svc", "org_xc", "org_lclf4XEbw-IpMyJt"];
  for (const orgId of clientOrgs) {
    for (const r of completeRepairBook) {
      lines.push(
        `INSERT INTO repair_book (org_id, model_id, part, price, source) VALUES (${[
          orgId,
          r.modelId,
          r.part,
          r.price,
          JSON.stringify(r.source),
        ]
          .map(pgLit)
          .join(", ")}) ON CONFLICT (org_id, model_id, part) DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source;`
      );
    }
    DATA.newDevices.forEach((n, idx) => {
      const ndId = `nd_${orgId.replace(/[^a-z0-9]/gi, "")}_${idx + 1}`;
      lines.push(
        `INSERT INTO new_devices (id, org_id, brand, model, series, variant, price, support_end_year, active, sort, source) VALUES (${[
          ndId,
          orgId,
          n.brand,
          n.model,
          n.series,
          n.variant,
          n.price,
          n.supportEndYear,
          1,
          n.sort,
          JSON.stringify(n.source),
        ]
          .map(pgLit)
          .join(", ")}) ON CONFLICT (id) DO NOTHING;`
      );
    });
  }

  lines.push("");
  lines.push("-- 6. Samsung & Apple Rate Cards (290 model+variant rows each, active = 1)");
  const demoCard = buildSamsungAppleRateCardObject({
    id: "rc_samsung_apple_demo",
    partnerName: "Buyback Partner (demo)",
    effectiveFrom: today,
  });
  const partnerCard = buildSamsungAppleRateCardObject({
    id: "rc_samsung_apple_partner",
    partnerName: "Buyback partner",
    effectiveFrom: today,
  });

  lines.push(`UPDATE rate_cards SET active = 0 WHERE partner_id IN ('ptn_demo', 'ptn_BfpxCIbbL6RTGPMk');`);
  lines.push(
    `INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES (${[
      demoCard.id,
      "ptn_demo",
      JSON.stringify(demoCard),
      1,
      "usr_partner",
      now,
    ]
      .map(pgLit)
      .join(", ")}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, active = 1;`
  );
  lines.push(
    `INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES (${[
      partnerCard.id,
      "ptn_BfpxCIbbL6RTGPMk",
      JSON.stringify(partnerCard),
      1,
      "usr_24G2U2zS1l-B6bF_",
      now,
    ]
      .map(pgLit)
      .join(", ")}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, active = 1;`
  );

  lines.push("");
  lines.push("-- 7. Migration & Seed Meta Flags");
  for (const metaKey of [
    "renamed_experience_centers",
    "renamed_demo_partner",
    "renamed_demo_partner_ids",
    "removed_example_cases",
    "retired_test_quotes",
    "samsung_apple_rate_card_v1",
    "complete_repair_book_v1",
  ]) {
    lines.push(
      `INSERT INTO meta (key, value) VALUES (${pgLit(metaKey)}, ${pgLit(now)}) ON CONFLICT (key) DO NOTHING;`
    );
  }

  lines.push("");
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

async function main() {
  ensureSeeded();

  const sql = generatePostgresSeedSql();
  const deployPath = path.join(process.cwd(), "deploy", "postgres-full-seed.sql");
  const publicPath = path.join(process.cwd(), "public", "postgres-full-seed.sql");
  fs.writeFileSync(deployPath, sql, "utf8");
  fs.writeFileSync(publicPath, sql, "utf8");

  const repairCsv = buildDeviceRepairCostsCsv();
  const deployRepairCsv = path.join(process.cwd(), "deploy", "device-repair-costs.csv");
  const publicRepairCsv = path.join(process.cwd(), "public", "device-repair-costs.csv");
  fs.writeFileSync(deployRepairCsv, repairCsv, "utf8");
  fs.writeFileSync(publicRepairCsv, repairCsv, "utf8");

  console.log(`[seed-postgres] Wrote PostgreSQL SQL dump (${(sql.length / 1024).toFixed(1)} KB) to:`);
  console.log(`  - ${deployPath}`);
  console.log(`  - ${publicPath}`);
  console.log(`[seed-postgres] Wrote Device Repair Costs CSV (${(repairCsv.length / 1024).toFixed(1)} KB) to:`);
  console.log(`  - ${deployRepairCsv}`);
  console.log(`  - ${publicRepairCsv}`);

  if (process.env.DATABASE_URL || process.env.PGHOST) {
    console.log(`[seed-postgres] Connecting to PostgreSQL (${process.env.DATABASE_URL ? "DATABASE_URL" : process.env.PGHOST})...`);
    const pool = getPool();
    await pool.query(sql);
    const res = await pool.query(`SELECT id, partner_id, active FROM rate_cards`);
    console.log(`[seed-postgres] Successfully seeded PostgreSQL database! Rate cards:`, res.rows);
    await pool.end();
  } else {
    console.log(`[seed-postgres] Note: Set DATABASE_URL or PGHOST to execute directly against PostgreSQL, or run:`);
    console.log(`  psql "$DATABASE_URL" -f deploy/postgres-full-seed.sql`);
  }
}

main().catch((err) => {
  console.error("[seed-postgres] Error:", err);
  process.exit(1);
});

