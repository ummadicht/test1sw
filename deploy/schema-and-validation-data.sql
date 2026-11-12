-- =============================================================================
-- SwapUp Trade-In & Upgrade Platform — Latest Schema & Validation Dummy Data
-- =============================================================================

-- 1. Core Schema (SQLite & PostgreSQL compatible)

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'platform' | 'partner' | 'client'
  client_type TEXT,                -- 'oem_service' | 'experience_center' | NULL
  target_brand TEXT,               -- e.g. 'Samsung'
  partner_id TEXT REFERENCES orgs(id),
  settings TEXT NOT NULL DEFAULT '{}',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'service_center' | 'experience_center'
  city TEXT NOT NULL,
  code TEXT NOT NULL,              -- Unique across all programmes in application logic (createStore & storeCode)
  credit_limit INTEGER NOT NULL DEFAULT 300000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  store_id TEXT REFERENCES stores(id),
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'platform' | 'partner' | 'org_admin' | 'store_manager' | 'advisor'
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_models (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,             -- 'Samsung' | 'Apple' | etc.
  model TEXT NOT NULL,
  series TEXT,                     -- 'Z' | 'S' | 'A' | 'M' | 'F' | NULL
  release_year INTEGER NOT NULL,
  support_end_year INTEGER,
  variants TEXT NOT NULL,          -- JSON array of storage variants e.g. '["128GB","256GB"]'
  service_tier TEXT NOT NULL,
  care_plus_fee INTEGER,
  model_codes TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repair_book (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  model_id TEXT NOT NULL REFERENCES trade_models(id),
  part TEXT NOT NULL,
  price INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (org_id, model_id, part)
);

CREATE TABLE IF NOT EXISTS new_devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  series TEXT NOT NULL,
  variant TEXT NOT NULL,
  price INTEGER NOT NULL,
  support_end_year INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_cards (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES orgs(id),
  data TEXT NOT NULL,              -- RateCard JSON containing source, deductions, and entries[]
  active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  data TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,        -- SU-<STORE_CODE>-<SEQ>
  org_id TEXT NOT NULL REFERENCES orgs(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  advisor_id TEXT REFERENCES users(id),
  status TEXT NOT NULL,            -- 'draft' | 'quoted' | 'locked' | 'in_pickup' | 'collected' | 'verified' | 'settled' | 'cancelled'
  customer TEXT NOT NULL,          -- JSON (hidden from buyback partner role per SUP-105)
  device TEXT NOT NULL,            -- JSON: { modelId, variant, imei, serial }
  condition TEXT,                  -- JSON
  repair TEXT,                     -- JSON
  target_device_id TEXT,
  quote TEXT,                      -- JSON
  repaired_quote TEXT,             -- JSON
  decision TEXT,                   -- JSON
  storage_quotes TEXT,             -- JSON
  camera_check TEXT,               -- JSON
  clearance TEXT,                  -- JSON
  chosen_path TEXT,
  trade_value INTEGER,
  bonus_value INTEGER,
  imei_check TEXT,
  lock_check TEXT,
  gradeiq_session_id TEXT,
  pickup_id TEXT,
  closed_reason TEXT,
  closed_at TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  case_id TEXT REFERENCES cases(id),
  pickup_id TEXT,
  kind TEXT NOT NULL,              -- 'hold' | 'release' | 'adjustment'
  amount INTEGER NOT NULL,
  note TEXT,
  by_user TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickups (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  partner_id TEXT NOT NULL REFERENCES orgs(id),
  status TEXT NOT NULL,            -- 'requested' | 'scheduled' | 'collected' | 'verified' | 'settled'
  scheduled_for TEXT,
  collector_name TEXT,
  collector_phone TEXT,
  pin_hash TEXT,
  requested_by TEXT REFERENCES users(id),
  collected_at TEXT,
  verified_at TEXT,
  settled_at TEXT,
  settlement_ref TEXT,
  settlement_amount INTEGER,
  notes TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  org_id TEXT,
  store_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS razorpay_payments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  case_ref TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  journey TEXT NOT NULL,           -- 'repair' | 'swap'
  payment_plan TEXT NOT NULL,      -- 'repair_part_advance' | 'repair_remaining' | 'repair_full' | 'swap_direct' | 'swap_emi'
  installment_stage TEXT NOT NULL, -- 'advance' | 'remaining' | 'full' | 'emi'
  total_case_payable INTEGER NOT NULL, -- Full repair bill or net swap differential in INR
  amount INTEGER NOT NULL,         -- Amount charged in this Razorpay order in INR
  remaining_due INTEGER NOT NULL DEFAULT 0, -- Remaining balance due on pickup (for repair_part_advance)
  emi_months INTEGER,              -- 3 | 6 | 9 | 12 | 18 | 24 (for swap_emi)
  emi_monthly_amount INTEGER,      -- Monthly EMI installment in INR
  currency TEXT NOT NULL DEFAULT 'INR',
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  payment_method TEXT,             -- 'upi' | 'card' | 'netbanking' | 'emi'
  status TEXT NOT NULL DEFAULT 'created', -- 'created' | 'paid' | 'failed' | 'refunded'
  customer_name TEXT,
  customer_phone TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_case_id ON razorpay_payments(case_id);

-- =============================================================================
-- 2. Validation Queries
-- =============================================================================
-- Check seeded organisations:
-- SELECT id, name, kind, partner_id, demo FROM orgs;
--
-- Check active Samsung & Apple rate cards (290 model+variant entries each):
-- SELECT id, partner_id, active, created_at FROM rate_cards WHERE active = 1;
--
-- Check complete device-specific repair costs (1,520 rows per client programme):
-- SELECT org_id, COUNT(*) AS repair_entries FROM repair_book GROUP BY org_id;
--
-- Check Razorpay payment orders & settlements:
-- SELECT id, case_ref, journey, payment_plan, installment_stage, amount, remaining_due, emi_months, status, razorpay_order_id, razorpay_payment_id FROM razorpay_payments ORDER BY created_at DESC;
--
-- Check store code uniqueness across all programmes:
-- SELECT code, COUNT(*) FROM stores GROUP BY code HAVING COUNT(*) > 1;


