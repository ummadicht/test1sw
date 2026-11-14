-- PostgreSQL Schema for Store Payout Requests, Immutable Payout Ledger, and Audit Logs
-- Supports Role-Based Access Control (RBAC), Manager Approval Workflow, and Razorpay Payouts

CREATE TABLE IF NOT EXISTS payout_requests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  case_ref TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  device_label TEXT,
  payout_mode TEXT NOT NULL DEFAULT 'upi',
  fund_account_upi TEXT,
  fund_account_bank_name TEXT,
  fund_account_number TEXT,
  fund_account_ifsc TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (
    status IN ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED', 'REVERSED')
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  requested_by_name TEXT,
  requested_by_role TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_by_name TEXT,
  reviewed_by_role TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  razorpay_payout_id TEXT UNIQUE,
  razorpay_fund_account_id TEXT,
  razorpay_status TEXT,
  razorpay_response TEXT,
  failure_reason TEXT,
  completed_at TEXT,
  notes TEXT,
  CONSTRAINT no_self_approval CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_store_id ON payout_requests(store_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_case_id ON payout_requests(case_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);

-- Immutable ledger entries for store payout debits and webhook reversals
CREATE TABLE IF NOT EXISTS payout_ledger (
  id SERIAL PRIMARY KEY,
  payout_id TEXT NOT NULL REFERENCES payout_requests(id),
  case_id TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'REVERSAL')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  razorpay_payout_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT,
  UNIQUE(payout_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_payout_ledger_store_id ON payout_ledger(store_id);
CREATE INDEX IF NOT EXISTS idx_payout_ledger_payout_id ON payout_ledger(payout_id);

-- Enforce ledger immutability in PostgreSQL (append-only, no UPDATE or DELETE)
CREATE OR REPLACE FUNCTION prevent_payout_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payout_ledger is immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_ledger_immutable ON payout_ledger;
CREATE TRIGGER trg_payout_ledger_immutable
BEFORE UPDATE OR DELETE ON payout_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_payout_ledger_mutation();

-- Audit log table (tracks user_id, role, timestamp, amount, and action details)
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
