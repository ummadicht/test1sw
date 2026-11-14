import { createHmac, randomBytes } from "node:crypto";
import { query, queryOne, execute, tx, nowIso, audit, db } from "./db";
import { HttpError, type SessionUser, type Role } from "./auth";
import { storeInScope, getStore } from "./scope";
import { storeEvents, storePolicy, storePayoutNetDebit } from "./credit";
import { position } from "../domain/credit";
import { getCase } from "./cases";

export type PayoutStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "REVERSED";

export type PayoutMode = "upi" | "imps" | "neft" | "store_credit";

export type PayoutRequestRow = {
  id: string;
  case_id: string;
  case_ref: string;
  org_id: string;
  store_id: string;
  customer_name: string;
  customer_phone: string;
  device_label: string | null;
  payout_mode: PayoutMode;
  fund_account_upi: string | null;
  fund_account_bank_name: string | null;
  fund_account_number: string | null;
  fund_account_ifsc: string | null;
  amount: number;
  currency: string;
  status: PayoutStatus;
  idempotency_key: string;
  requested_by: string;
  requested_by_name: string | null;
  requested_by_role: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_by_role: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  razorpay_payout_id: string | null;
  razorpay_fund_account_id: string | null;
  razorpay_status: string | null;
  razorpay_response: string | null;
  failure_reason: string | null;
  completed_at: string | null;
  notes: string | null;
};

export type PayoutLedgerRow = {
  id: number;
  payout_id: string;
  case_id: string;
  store_id: string;
  org_id: string;
  entry_type: "DEBIT" | "REVERSAL";
  amount: number;
  balance_before: number;
  balance_after: number;
  razorpay_payout_id: string | null;
  created_by: string;
  created_at: string;
  note: string | null;
};

/** Customer-facing payout view safe for Store Counter (`advisor`) users — NEVER includes store balance fields. */
export type CounterPayoutView = {
  id: string;
  caseId: string;
  caseRef: string;
  storeId: string;
  customerName: string;
  customerPhone: string;
  deviceLabel: string | null;
  payoutMode: PayoutMode;
  fundAccountUpi: string | null;
  fundAccountBankName: string | null;
  fundAccountNumber: string | null;
  fundAccountIfsc: string | null;
  amount: number;
  currency: string;
  status: PayoutStatus;
  idempotencyKey: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedByRole: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedByRole: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  razorpayPayoutId: string | null;
  razorpayStatus: string | null;
  failureReason: string | null;
  completedAt: string | null;
};

/** Manager payout view — includes store balance before/after payout, Razorpay response details, and manager alerts. */
export type ManagerPayoutView = CounterPayoutView & {
  balanceBefore: number;
  balanceAfter: number;
  canApprove: boolean;
  selfApprovalBlocked: boolean;
  managerAlert: string | null;
  razorpayFundAccountId: string | null;
  razorpayResponse: Record<string, unknown> | null;
};

let tablesReady = false;
function ensurePayoutTablesSync(): void {
  if (tablesReady || process.env.DATABASE_URL || process.env.PGHOST) return;
  try {
    const sqlite = db();
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS payout_requests (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        case_ref TEXT NOT NULL,
        org_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        device_label TEXT,
        payout_mode TEXT NOT NULL DEFAULT 'upi',
        fund_account_upi TEXT,
        fund_account_bank_name TEXT,
        fund_account_number TEXT,
        fund_account_ifsc TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
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
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payout_requests_store_id ON payout_requests(store_id);
      CREATE INDEX IF NOT EXISTS idx_payout_requests_case_id ON payout_requests(case_id);
      CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);

      CREATE TABLE IF NOT EXISTS payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        amount INTEGER NOT NULL,
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

      CREATE TRIGGER IF NOT EXISTS trg_payout_ledger_no_update
      BEFORE UPDATE ON payout_ledger
      BEGIN
        SELECT RAISE(ABORT, 'payout_ledger is immutable and cannot be updated');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_payout_ledger_no_delete
      BEFORE DELETE ON payout_ledger
      BEGIN
        SELECT RAISE(ABORT, 'payout_ledger is immutable and cannot be deleted');
      END;
    `);
    tablesReady = true;
  } catch {
    // ignore if already initialized
  }
}

function normalizePayoutRow(r: Record<string, unknown>): PayoutRequestRow {
  return {
    id: String(r.id),
    case_id: String(r.case_id),
    case_ref: String(r.case_ref),
    org_id: String(r.org_id),
    store_id: String(r.store_id),
    customer_name: String(r.customer_name),
    customer_phone: String(r.customer_phone),
    device_label: r.device_label ? String(r.device_label) : null,
    payout_mode: (String(r.payout_mode || "upi") as PayoutMode),
    fund_account_upi: r.fund_account_upi ? String(r.fund_account_upi) : null,
    fund_account_bank_name: r.fund_account_bank_name ? String(r.fund_account_bank_name) : null,
    fund_account_number: r.fund_account_number ? String(r.fund_account_number) : null,
    fund_account_ifsc: r.fund_account_ifsc ? String(r.fund_account_ifsc) : null,
    amount: Number(r.amount),
    currency: String(r.currency || "INR"),
    status: String(r.status) as PayoutStatus,
    idempotency_key: String(r.idempotency_key),
    requested_by: String(r.requested_by),
    requested_by_name: r.requested_by_name ? String(r.requested_by_name) : null,
    requested_by_role: String(r.requested_by_role),
    requested_at: String(r.requested_at),
    reviewed_by: r.reviewed_by ? String(r.reviewed_by) : null,
    reviewed_by_name: r.reviewed_by_name ? String(r.reviewed_by_name) : null,
    reviewed_by_role: r.reviewed_by_role ? String(r.reviewed_by_role) : null,
    reviewed_at: r.reviewed_at ? String(r.reviewed_at) : null,
    rejection_reason: r.rejection_reason ? String(r.rejection_reason) : null,
    razorpay_payout_id: r.razorpay_payout_id ? String(r.razorpay_payout_id) : null,
    razorpay_fund_account_id: r.razorpay_fund_account_id ? String(r.razorpay_fund_account_id) : null,
    razorpay_status: r.razorpay_status ? String(r.razorpay_status) : null,
    razorpay_response: r.razorpay_response ? String(r.razorpay_response) : null,
    failure_reason: r.failure_reason ? String(r.failure_reason) : null,
    completed_at: r.completed_at ? String(r.completed_at) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}

/** Internal helper to compute a store's current available balance in rupees. */
async function computeStoreBalanceInternal(storeId: string): Promise<{
  creditLimit: number;
  creditExposure: number;
  payoutsDebited: number;
  availableBalance: number;
}> {
  ensurePayoutTablesSync();
  const store = await getStore(storeId);
  if (!store) throw new HttpError(404, "Store not found.");
  const policy = await storePolicy(store);
  const events = await storeEvents(store.id);
  const pos = position(policy, events);
  const payoutsDebited = await storePayoutNetDebit(store.id);
  const availableBalance = policy.limit - pos.exposure - payoutsDebited;
  return {
    creditLimit: policy.limit,
    creditExposure: pos.exposure,
    payoutsDebited,
    availableBalance,
  };
}

/**
 * Role-checked store balance reader.
 * Store counter users (`advisor`) are strictly forbidden (403) from viewing store balance figures.
 */
export async function getStoreBalanceForManager(
  u: SessionUser,
  storeId: string
): Promise<{
  storeId: string;
  storeName: string;
  creditLimit: number;
  creditExposure: number;
  payoutsDebited: number;
  availableBalance: number;
}> {
  if (u.role === "advisor" || !["store_manager", "org_admin", "platform"].includes(u.role)) {
    await audit({
      userId: u.id,
      orgId: u.orgId,
      storeId: u.storeId,
      action: "payout.balance_access_denied",
      entity: "store",
      entityId: storeId,
      detail: { userId: u.id, role: u.role, timestamp: nowIso() },
    });
    throw new HttpError(403, "Store counter users are not permitted to view store balance figures.");
  }
  const store = await storeInScope(u, storeId);
  const bal = await computeStoreBalanceInternal(store.id);
  return {
    storeId: store.id,
    storeName: store.name,
    ...bal,
  };
}

/** Converts a DB row to the customer-facing view (strips all store balance and internal Razorpay payload fields). */
export function toCounterPayoutView(row: PayoutRequestRow): CounterPayoutView {
  return {
    id: row.id,
    caseId: row.case_id,
    caseRef: row.case_ref,
    storeId: row.store_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    deviceLabel: row.device_label,
    payoutMode: row.payout_mode,
    fundAccountUpi: row.fund_account_upi,
    fundAccountBankName: row.fund_account_bank_name,
    fundAccountNumber: row.fund_account_number,
    fundAccountIfsc: row.fund_account_ifsc,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedByRole: row.requested_by_role,
    requestedAt: row.requested_at,
    reviewedBy: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewedByRole: row.reviewed_by_role,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    razorpayPayoutId: row.razorpay_payout_id,
    razorpayStatus: row.razorpay_status,
    failureReason: row.failure_reason,
    completedAt: row.completed_at,
  };
}

/** Converts a DB row to a role-filtered view: CounterPayoutView for `advisor`, ManagerPayoutView for `store_manager`. */
export async function toViewerPayoutView(
  u: SessionUser,
  row: PayoutRequestRow,
  currentStoreBalance?: number
): Promise<CounterPayoutView | ManagerPayoutView> {
  const base = toCounterPayoutView(row);
  if (u.role === "advisor") {
    return base;
  }

  // For managers/admins, attach historical ledger balance if completed, or live projected balance before/after
  const ledgerEntry = await queryOne<Record<string, unknown>>(
    `SELECT * FROM payout_ledger WHERE payout_id = $1 ORDER BY id DESC LIMIT 1`,
    [row.id]
  );

  let balanceBefore: number;
  let balanceAfter: number;
  if (ledgerEntry) {
    balanceBefore = Number(ledgerEntry.balance_before);
    balanceAfter = Number(ledgerEntry.balance_after);
  } else {
    const liveBalance =
      currentStoreBalance !== undefined
        ? currentStoreBalance
        : (await computeStoreBalanceInternal(row.store_id)).availableBalance;
    balanceBefore = liveBalance;
    balanceAfter = row.status === "REJECTED" || row.status === "FAILED" ? liveBalance : liveBalance - row.amount;
  }

  let parsedRzp: Record<string, unknown> | null = null;
  if (row.razorpay_response) {
    try {
      parsedRzp = JSON.parse(row.razorpay_response) as Record<string, unknown>;
    } catch {
      parsedRzp = null;
    }
  }

  const selfApprovalBlocked = row.requested_by === u.id;
  const canApprove =
    u.role === "store_manager" &&
    row.status === "PENDING_APPROVAL" &&
    !selfApprovalBlocked &&
    balanceBefore >= row.amount;

  let managerAlert: string | null = null;
  if (row.status === "FAILED") {
    managerAlert = `Payout failed (${row.failure_reason || "Razorpay error"}). Store balance was NOT debited.`;
  } else if (row.status === "PROCESSING") {
    managerAlert = `Payout is processing with Razorpay (${row.razorpay_payout_id || "pending"}). Store balance will only be debited once confirmed.`;
  } else if (row.status === "REVERSED") {
    managerAlert = `Payout was reversed by Razorpay (${row.failure_reason || "reversed"}). Store balance has been restored in the ledger.`;
  } else if (row.status === "PENDING_APPROVAL" && balanceBefore < row.amount) {
    managerAlert = `Insufficient store balance for this request (short by ₹${(row.amount - balanceBefore).toLocaleString("en-IN")}).`;
  }

  return {
    ...base,
    balanceBefore,
    balanceAfter,
    canApprove,
    selfApprovalBlocked,
    managerAlert,
    razorpayFundAccountId: row.razorpay_fund_account_id,
    razorpayResponse: parsedRzp,
  };
}

export type CreatePayoutInput = {
  caseId: string;
  amount?: number;
  payoutMode?: PayoutMode;
  fundAccountUpi?: string | null;
  fundAccountBankName?: string | null;
  fundAccountNumber?: string | null;
  fundAccountIfsc?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  idempotencyKey?: string | null;
  notes?: string | null;
};

/**
 * Counter user (`advisor` or `store_manager`) creates a customer payout request when the customer
 * accepts the trade-in payout or store credit cash-out.
 * - Saved with status `PENDING_APPROVAL` and routed to the store manager.
 * - Idempotent on `idempotencyKey`.
 * - Returns ONLY customer-facing fields when called by `advisor` (never store balance).
 */
export async function createPayoutRequest(
  u: SessionUser,
  input: CreatePayoutInput
): Promise<CounterPayoutView | ManagerPayoutView> {
  ensurePayoutTablesSync();
  if (!["advisor", "store_manager"].includes(u.role)) {
    await audit({
      userId: u.id,
      orgId: u.orgId,
      storeId: u.storeId,
      action: "payout.request.forbidden",
      entity: "case",
      entityId: input.caseId,
      detail: { userId: u.id, role: u.role, timestamp: nowIso() },
    });
    throw new HttpError(403, "Only store counter staff or store managers can create payout requests.");
  }

  const caseView = await getCase(u, input.caseId);
  const store = await storeInScope(u, caseView.storeId);

  const idempotencyKey = (input.idempotencyKey || "").trim() || `idem_${caseView.id}_${randomBytes(8).toString("hex")}`;

  // Check idempotency key first
  const existingByKey = await queryOne<Record<string, unknown>>(
    `SELECT * FROM payout_requests WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existingByKey) {
    const existingRow = normalizePayoutRow(existingByKey);
    if (existingRow.store_id !== store.id) {
      throw new HttpError(409, "Idempotency key belongs to another store.");
    }
    return toViewerPayoutView(u, existingRow);
  }

  // Determine customer payout amount (trade-in value + premium, or explicit amount)
  const defaultPayout =
    caseView.tradeValue !== null
      ? caseView.tradeValue + (caseView.premiumValue ?? 0)
      : caseView.offer?.swap.wePay ?? caseView.quote?.amount ?? 0;

  const amount = input.amount !== undefined && input.amount !== null ? Math.round(Number(input.amount)) : defaultPayout;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, "Payout amount must be a positive whole rupee amount.");
  }

  const payoutMode: PayoutMode = input.payoutMode || "upi";
  if (!["upi", "imps", "neft", "store_credit"].includes(payoutMode)) {
    throw new HttpError(400, "Invalid payout mode. Choose upi, imps, neft, or store_credit.");
  }

  const upi = (input.fundAccountUpi || "").trim() || null;
  const bankName = (input.fundAccountBankName || "").trim() || null;
  const accNum = (input.fundAccountNumber || "").trim() || null;
  const ifsc = (input.fundAccountIfsc || "").trim().toUpperCase() || null;

  if (payoutMode === "upi" && !upi) {
    throw new HttpError(400, "Customer UPI ID (VPA) is required for UPI payout.");
  }
  if ((payoutMode === "imps" || payoutMode === "neft") && (!accNum || !ifsc)) {
    throw new HttpError(400, "Customer bank account number and IFSC code are required for bank payout.");
  }

  const customerName = (input.customerName || caseView.customer?.name || "Customer").trim();
  const customerPhone = (input.customerPhone || caseView.customer?.phone || "").replace(/\D/g, "") || "9999999999";
  const deviceLabel = caseView.device
    ? `${caseView.device.brand} ${caseView.device.model}${caseView.device.variant ? ` ${caseView.device.variant}` : ""}`
    : "Trade-in device";

  const id = `pout_req_${randomBytes(8).toString("hex")}`;
  const now = nowIso();

  await tx(async () => {
    await execute(
      `INSERT INTO payout_requests (
        id, case_id, case_ref, org_id, store_id, customer_name, customer_phone, device_label,
        payout_mode, fund_account_upi, fund_account_bank_name, fund_account_number, fund_account_ifsc,
        amount, currency, status, idempotency_key, requested_by, requested_by_name, requested_by_role,
        requested_at, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'INR','PENDING_APPROVAL',$15,$16,$17,$18,$19,$20)`,
      [
        id,
        caseView.id,
        caseView.ref,
        caseView.orgId,
        store.id,
        customerName,
        customerPhone,
        deviceLabel,
        payoutMode,
        upi,
        bankName,
        accNum,
        ifsc,
        amount,
        idempotencyKey,
        u.id,
        u.name,
        u.role,
        now,
        input.notes ?? null,
      ]
    );

    await audit({
      userId: u.id,
      orgId: caseView.orgId,
      storeId: store.id,
      action: "payout.request.created",
      entity: "payout_request",
      entityId: id,
      detail: {
        userId: u.id,
        role: u.role,
        timestamp: now,
        amount,
        caseId: caseView.id,
        caseRef: caseView.ref,
        payoutMode,
        idempotencyKey,
        status: "PENDING_APPROVAL",
      },
    });
  });

  const created = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [id]);
  return toViewerPayoutView(u, normalizePayoutRow(created!));
}

function getRazorpayPayoutConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  const accountNumber = process.env.RAZORPAY_ACCOUNT_NUMBER || "";
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
  const liveConfigured = Boolean(keyId && keySecret && accountNumber);
  return { keyId, keySecret, accountNumber, webhookSecret, liveConfigured };
}

type RazorpayPayoutApiResult = {
  payoutId: string;
  fundAccountId: string;
  status: "processed" | "processing" | "queued" | "pending" | "failed" | "rejected";
  failureReason: string | null;
  rawResponse: Record<string, unknown>;
};

/**
 * Executes a payout via Razorpay Payouts API (`https://api.razorpay.com/v1/payouts`)
 * using the customer's fund account and the request's `idempotency_key` (`X-Payout-Idempotency`).
 * Falls back to a deterministic Razorpay Payouts response when live credentials are not configured in `.env`.
 */
async function executeRazorpayPayout(
  row: PayoutRequestRow,
  opts?: { simulateOutcome?: "processed" | "processing" | "failed" }
): Promise<RazorpayPayoutApiResult> {
  const { keyId, keySecret, accountNumber, liveConfigured } = getRazorpayPayoutConfig();
  const fundAccountId = row.razorpay_fund_account_id || `fa_${randomBytes(7).toString("hex")}`;

  // If caller explicitly requests a simulated Razorpay outcome (for test suite or sandbox verification) or live keys aren't set
  if (opts?.simulateOutcome || !liveConfigured) {
    const simStatus = opts?.simulateOutcome || "processed";
    const payoutId = row.razorpay_payout_id || `pout_${randomBytes(8).toString("hex")}`;
    const failureReason =
      simStatus === "failed" ? "Beneficiary bank / UPI handle declined the transfer (simulated)." : null;
    const rawResponse: Record<string, unknown> = {
      id: payoutId,
      entity: "payout",
      fund_account_id: fundAccountId,
      amount: row.amount * 100, // paise
      currency: "INR",
      mode: row.payout_mode === "upi" ? "UPI" : row.payout_mode === "neft" ? "NEFT" : "IMPS",
      purpose: "payout",
      status: simStatus,
      utr: simStatus === "processed" ? `UTR${Date.now().toString().slice(-8)}` : null,
      reference_id: row.case_ref,
      narration: `SwapUp TradeIn ${row.case_ref}`,
      failure_reason: failureReason,
      idempotency_key: row.idempotency_key,
      created_at: Math.floor(Date.now() / 1000),
    };
    return {
      payoutId,
      fundAccountId,
      status: simStatus,
      failureReason,
      rawResponse,
    };
  }

  // Live RazorpayX Payouts API call
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const mode = row.payout_mode === "upi" ? "UPI" : row.payout_mode === "neft" ? "NEFT" : "IMPS";
  const fundAccount =
    row.payout_mode === "upi"
      ? {
          account_type: "vpa",
          vpa: { address: row.fund_account_upi },
          contact: {
            name: row.customer_name,
            contact: row.customer_phone,
            type: "customer",
            reference_id: row.case_ref,
          },
        }
      : {
          account_type: "bank_account",
          bank_account: {
            name: row.customer_name,
            ifsc: row.fund_account_ifsc,
            account_number: row.fund_account_number,
          },
          contact: {
            name: row.customer_name,
            contact: row.customer_phone,
            type: "customer",
            reference_id: row.case_ref,
          },
        };

  try {
    const res = await fetch("https://api.razorpay.com/v1/payouts", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "X-Payout-Idempotency": row.idempotency_key,
      },
      body: JSON.stringify({
        account_number: accountNumber,
        amount: row.amount * 100, // in paise
        currency: "INR",
        mode,
        purpose: "payout",
        fund_account: fundAccount,
        queue_if_low_balance: false,
        reference_id: row.case_ref,
        narration: `SwapUp TradeIn ${row.case_ref}`,
        notes: {
          payout_request_id: row.id,
          case_id: row.case_id,
          store_id: row.store_id,
        },
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !data.id) {
      const errDesc =
        (data.error as { description?: string } | undefined)?.description ||
        `Razorpay Payouts API returned HTTP ${res.status}`;
      return {
        payoutId: `pout_err_${randomBytes(6).toString("hex")}`,
        fundAccountId,
        status: "failed",
        failureReason: errDesc,
        rawResponse: data,
      };
    }

    const rzpStatus = String(data.status || "processing").toLowerCase();
    const mappedStatus: RazorpayPayoutApiResult["status"] =
      rzpStatus === "processed"
        ? "processed"
        : rzpStatus === "failed" || rzpStatus === "rejected" || rzpStatus === "cancelled"
          ? "failed"
          : "processing";

    return {
      payoutId: String(data.id),
      fundAccountId: String(data.fund_account_id || fundAccountId),
      status: mappedStatus,
      failureReason: data.failure_reason ? String(data.failure_reason) : null,
      rawResponse: data,
    };
  } catch (err) {
    return {
      payoutId: `pout_err_${randomBytes(6).toString("hex")}`,
      fundAccountId,
      status: "failed",
      failureReason: (err as Error).message || "Network error calling Razorpay Payouts API",
      rawResponse: { error: (err as Error).message },
    };
  }
}

/**
 * Store Manager approves a payout request and triggers the Razorpay Payout:
 * - Only `store_manager` role is permitted (403 for `advisor` or others).
 * - Self-approval is strictly blocked: a manager cannot approve a request they created (`requested_by === u.id`).
 * - Sets status to `APPROVED`, calls Razorpay Payouts API, stores `razorpay_payout_id` and response.
 * - On `processed`: marks `COMPLETED`, debits store balance, and writes an immutable `DEBIT` entry in `payout_ledger`.
 * - On `processing` / `failed`: marks `PROCESSING` or `FAILED`, does NOT debit balance until confirmed, and alerts manager.
 */
export async function approvePayoutRequest(
  u: SessionUser,
  payoutId: string,
  opts?: { simulateOutcome?: "processed" | "processing" | "failed" }
): Promise<ManagerPayoutView> {
  ensurePayoutTablesSync();
  const now = nowIso();

  if (u.role !== "store_manager") {
    await audit({
      userId: u.id,
      orgId: u.orgId,
      storeId: u.storeId,
      action: "payout.approval.forbidden",
      entity: "payout_request",
      entityId: payoutId,
      detail: { userId: u.id, role: u.role, timestamp: now, reason: "Only Store Manager can approve payouts" },
    });
    throw new HttpError(403, "Only a Store Manager can approve and initiate store payouts.");
  }

  const raw = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [payoutId]);
  if (!raw) throw new HttpError(404, "Payout request not found.");
  const row = normalizePayoutRow(raw);

  await storeInScope(u, row.store_id);

  // Prevent manager from approving their own request if they also created it
  if (row.requested_by === u.id) {
    await audit({
      userId: u.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "payout.approval.self_blocked",
      entity: "payout_request",
      entityId: row.id,
      detail: { userId: u.id, role: u.role, timestamp: now, amount: row.amount },
    });
    throw new HttpError(403, "A Store Manager cannot approve a payout request that they created themselves.");
  }

  // Idempotent return if already processed/completed/processing
  if (row.status === "COMPLETED" || row.status === "PROCESSING" || row.status === "APPROVED") {
    return (await toViewerPayoutView(u, row)) as ManagerPayoutView;
  }

  if (row.status !== "PENDING_APPROVAL") {
    throw new HttpError(409, `Cannot approve a payout request in status ${row.status}.`);
  }

  const balanceInfo = await computeStoreBalanceInternal(row.store_id);
  const balanceBefore = balanceInfo.availableBalance;
  if (balanceBefore < row.amount) {
    await audit({
      userId: u.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "payout.approval.insufficient_balance",
      entity: "payout_request",
      entityId: row.id,
      detail: {
        userId: u.id,
        role: u.role,
        timestamp: now,
        amount: row.amount,
        balanceBefore,
      },
    });
    throw new HttpError(
      409,
      `Insufficient store available balance (₹${balanceBefore.toLocaleString("en-IN")}) for payout of ₹${row.amount.toLocaleString("en-IN")}.`
    );
  }

  // Step 1: Transition to APPROVED and log approval audit
  await execute(
    `UPDATE payout_requests
     SET status = 'APPROVED', reviewed_by = $1, reviewed_by_name = $2, reviewed_by_role = $3, reviewed_at = $4
     WHERE id = $5`,
    [u.id, u.name, u.role, now, row.id]
  );

  await audit({
    userId: u.id,
    orgId: row.org_id,
    storeId: row.store_id,
    action: "payout.request.approved",
    entity: "payout_request",
    entityId: row.id,
    detail: {
      userId: u.id,
      role: u.role,
      timestamp: now,
      amount: row.amount,
      balanceBefore,
      balanceAfter: balanceBefore - row.amount,
    },
  });

  // Step 2: Trigger Razorpay Payout
  const rzpResult = await executeRazorpayPayout(row, opts);
  const afterRzpAt = nowIso();

  await audit({
    userId: u.id,
    orgId: row.org_id,
    storeId: row.store_id,
    action: "payout.razorpay.attempt",
    entity: "payout_request",
    entityId: row.id,
    detail: {
      userId: u.id,
      role: u.role,
      timestamp: afterRzpAt,
      amount: row.amount,
      razorpayPayoutId: rzpResult.payoutId,
      razorpayStatus: rzpResult.status,
      idempotencyKey: row.idempotency_key,
    },
  });

  // Step 3: Update final status & ledger based on Razorpay response
  if (rzpResult.status === "processed") {
    await tx(async () => {
      const freshBal = (await computeStoreBalanceInternal(row.store_id)).availableBalance;
      const afterBal = freshBal - row.amount;

      await execute(
        `UPDATE payout_requests
         SET status = 'COMPLETED',
             razorpay_payout_id = $1,
             razorpay_fund_account_id = $2,
             razorpay_status = $3,
             razorpay_response = $4,
             completed_at = $5,
             failure_reason = NULL
         WHERE id = $6`,
        [
          rzpResult.payoutId,
          rzpResult.fundAccountId,
          rzpResult.status,
          JSON.stringify(rzpResult.rawResponse),
          afterRzpAt,
          row.id,
        ]
      );

      // Immutable ledger entry (UNIQUE(payout_id, entry_type) prevents duplicate debit)
      await execute(
        `INSERT INTO payout_ledger (
          payout_id, case_id, store_id, org_id, entry_type, amount,
          balance_before, balance_after, razorpay_payout_id, created_by, created_at, note
        ) VALUES ($1,$2,$3,$4,'DEBIT',$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (payout_id, entry_type) DO NOTHING`,
        [
          row.id,
          row.case_id,
          row.store_id,
          row.org_id,
          row.amount,
          freshBal,
          afterBal,
          rzpResult.payoutId,
          u.id,
          afterRzpAt,
          `Customer trade-in payout (${row.case_ref}) via Razorpay (${rzpResult.payoutId})`,
        ]
      );

      await audit({
        userId: u.id,
        orgId: row.org_id,
        storeId: row.store_id,
        action: "payout.completed",
        entity: "payout_request",
        entityId: row.id,
        detail: {
          userId: u.id,
          role: u.role,
          timestamp: afterRzpAt,
          amount: row.amount,
          balanceBefore: freshBal,
          balanceAfter: afterBal,
          razorpayPayoutId: rzpResult.payoutId,
        },
      });
    });
  } else if (rzpResult.status === "failed" || rzpResult.status === "rejected") {
    await execute(
      `UPDATE payout_requests
       SET status = 'FAILED',
           razorpay_payout_id = $1,
           razorpay_fund_account_id = $2,
           razorpay_status = $3,
           razorpay_response = $4,
           failure_reason = $5
       WHERE id = $6`,
      [
        rzpResult.payoutId,
        rzpResult.fundAccountId,
        rzpResult.status,
        JSON.stringify(rzpResult.rawResponse),
        rzpResult.failureReason || "Razorpay payout failed",
        row.id,
      ]
    );

    await audit({
      userId: u.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "payout.failed",
      entity: "payout_request",
      entityId: row.id,
      detail: {
        userId: u.id,
        role: u.role,
        timestamp: afterRzpAt,
        amount: row.amount,
        razorpayPayoutId: rzpResult.payoutId,
        failureReason: rzpResult.failureReason,
        balanceDebited: false,
      },
    });
  } else {
    // queued / pending / processing -> mark PROCESSING, do NOT debit store balance until webhook confirms
    await execute(
      `UPDATE payout_requests
       SET status = 'PROCESSING',
           razorpay_payout_id = $1,
           razorpay_fund_account_id = $2,
           razorpay_status = $3,
           razorpay_response = $4
       WHERE id = $5`,
      [
        rzpResult.payoutId,
        rzpResult.fundAccountId,
        rzpResult.status,
        JSON.stringify(rzpResult.rawResponse),
        row.id,
      ]
    );

    await audit({
      userId: u.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "payout.processing",
      entity: "payout_request",
      entityId: row.id,
      detail: {
        userId: u.id,
        role: u.role,
        timestamp: afterRzpAt,
        amount: row.amount,
        razorpayPayoutId: rzpResult.payoutId,
        balanceDebited: false,
      },
    });
  }

  const updated = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [row.id]);
  return (await toViewerPayoutView(u, normalizePayoutRow(updated!))) as ManagerPayoutView;
}

/**
 * Store Manager rejects a payout request:
 * - Sets status to `REJECTED`, records reason, notifies counter user.
 * - No money moves; store balance is untouched.
 */
export async function rejectPayoutRequest(
  u: SessionUser,
  payoutId: string,
  reason: string
): Promise<ManagerPayoutView> {
  ensurePayoutTablesSync();
  const now = nowIso();

  if (u.role !== "store_manager") {
    await audit({
      userId: u.id,
      orgId: u.orgId,
      storeId: u.storeId,
      action: "payout.rejection.forbidden",
      entity: "payout_request",
      entityId: payoutId,
      detail: { userId: u.id, role: u.role, timestamp: now },
    });
    throw new HttpError(403, "Only a Store Manager can reject payout requests.");
  }

  const cleanReason = (reason || "").trim();
  if (cleanReason.length < 3) {
    throw new HttpError(400, "Please provide a rejection reason (at least 3 characters).");
  }

  const raw = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [payoutId]);
  if (!raw) throw new HttpError(404, "Payout request not found.");
  const row = normalizePayoutRow(raw);

  await storeInScope(u, row.store_id);

  if (row.status === "REJECTED") {
    return (await toViewerPayoutView(u, row)) as ManagerPayoutView;
  }
  if (row.status !== "PENDING_APPROVAL") {
    throw new HttpError(409, `Cannot reject a payout request in status ${row.status}.`);
  }

  await tx(async () => {
    await execute(
      `UPDATE payout_requests
       SET status = 'REJECTED',
           reviewed_by = $1,
           reviewed_by_name = $2,
           reviewed_by_role = $3,
           reviewed_at = $4,
           rejection_reason = $5
       WHERE id = $6`,
      [u.id, u.name, u.role, now, cleanReason, row.id]
    );

    await audit({
      userId: u.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "payout.request.rejected",
      entity: "payout_request",
      entityId: row.id,
      detail: {
        userId: u.id,
        role: u.role,
        timestamp: now,
        amount: row.amount,
        reason: cleanReason,
      },
    });
  });

  const updated = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [row.id]);
  return (await toViewerPayoutView(u, normalizePayoutRow(updated!))) as ManagerPayoutView;
}

/**
 * Lists payout requests for a store or case, enforcing server-side role stripping:
 * - For `advisor`: returns ONLY `payouts: CounterPayoutView[]` (no `storeBalance`, no `balanceBefore`, no `balanceAfter`, no `ledger`).
 * - For `store_manager` (and higher admins): returns `payouts: ManagerPayoutView[]`, `storeBalance`, `pendingCount`, `alertCount`, and `ledger`.
 */
export async function listPayoutRequests(
  u: SessionUser,
  opts: { storeId?: string | null; caseId?: string | null; status?: PayoutStatus | null } = {}
): Promise<{
  payouts: (CounterPayoutView | ManagerPayoutView)[];
  storeBalance?: {
    storeId: string;
    storeName: string;
    creditLimit: number;
    creditExposure: number;
    payoutsDebited: number;
    availableBalance: number;
  };
  pendingCount: number;
  alertCount: number;
  ledger?: PayoutLedgerRow[];
}> {
  ensurePayoutTablesSync();
  if (u.role === "partner") {
    throw new HttpError(403, "Buyback partners do not have access to store customer payouts.");
  }

  let targetStoreId = opts.storeId || u.storeId || null;
  if (opts.caseId) {
    const c = await getCase(u, opts.caseId);
    targetStoreId = c.storeId;
  }
  if (!targetStoreId) {
    return { payouts: [], pendingCount: 0, alertCount: 0 };
  }

  const store = await storeInScope(u, targetStoreId);

  const clauses: string[] = ["store_id = $1"];
  const params: unknown[] = [store.id];
  if (opts.caseId) {
    params.push(opts.caseId);
    clauses.push(`case_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    clauses.push(`status = $${params.length}`);
  }

  const rawRows = await query<Record<string, unknown>>(
    `SELECT * FROM payout_requests WHERE ${clauses.join(" AND ")} ORDER BY requested_at DESC, id DESC LIMIT 100`,
    params
  );
  const rows = rawRows.map(normalizePayoutRow);

  if (u.role === "advisor") {
    // Strictly strip all store balance and ledger fields for counter login users
    return {
      payouts: rows.map(toCounterPayoutView),
      pendingCount: rows.filter((r) => r.status === "PENDING_APPROVAL").length,
      alertCount: rows.filter((r) => r.status === "REJECTED").length,
    };
  }

  const bal = await computeStoreBalanceInternal(store.id);
  const managerViews: ManagerPayoutView[] = [];
  for (const r of rows) {
    managerViews.push((await toViewerPayoutView(u, r, bal.availableBalance)) as ManagerPayoutView);
  }

  const rawLedger = await query<Record<string, unknown>>(
    `SELECT * FROM payout_ledger WHERE store_id = $1 ORDER BY id DESC LIMIT 100`,
    [store.id]
  );
  const ledger: PayoutLedgerRow[] = rawLedger.map((l) => ({
    id: Number(l.id),
    payout_id: String(l.payout_id),
    case_id: String(l.case_id),
    store_id: String(l.store_id),
    org_id: String(l.org_id),
    entry_type: String(l.entry_type) as "DEBIT" | "REVERSAL",
    amount: Number(l.amount),
    balance_before: Number(l.balance_before),
    balance_after: Number(l.balance_after),
    razorpay_payout_id: l.razorpay_payout_id ? String(l.razorpay_payout_id) : null,
    created_by: String(l.created_by),
    created_at: String(l.created_at),
    note: l.note ? String(l.note) : null,
  }));

  return {
    payouts: managerViews,
    storeBalance: {
      storeId: store.id,
      storeName: store.name,
      ...bal,
    },
    pendingCount: rows.filter((r) => r.status === "PENDING_APPROVAL").length,
    alertCount: rows.filter((r) => r.status === "FAILED" || r.status === "PROCESSING" || r.status === "REVERSED").length,
    ledger,
  };
}

export async function getPayoutRequestById(
  u: SessionUser,
  payoutId: string
): Promise<CounterPayoutView | ManagerPayoutView> {
  ensurePayoutTablesSync();
  const raw = await queryOne<Record<string, unknown>>(`SELECT * FROM payout_requests WHERE id = $1`, [payoutId]);
  if (!raw) throw new HttpError(404, "Payout request not found.");
  const row = normalizePayoutRow(raw);
  await storeInScope(u, row.store_id);
  return toViewerPayoutView(u, row);
}

/**
 * Handles Razorpay Payout webhooks (`payout.processed`, `payout.failed`, `payout.reversed`) idempotently:
 * - Verifies HMAC-SHA256 webhook signature when `RAZORPAY_WEBHOOK_SECRET` is set.
 * - `payout.processed`: transitions payout to `COMPLETED`, debits store balance, writes immutable `DEBIT` entry in `payout_ledger`.
 * - `payout.failed`: transitions payout to `FAILED`, does not debit balance, alerts manager.
 * - `payout.reversed`: transitions payout to `REVERSED` and, if previously debited, writes an immutable `REVERSAL` entry in `payout_ledger` to restore store balance.
 */
export async function handleRazorpayPayoutWebhook(
  eventPayload: Record<string, unknown>,
  rawBody: string,
  signatureHeader: string | null
): Promise<{
  ok: true;
  event: string;
  payoutId: string | null;
  status: PayoutStatus | null;
  idempotent: boolean;
}> {
  ensurePayoutTablesSync();
  const { webhookSecret } = getRazorpayPayoutConfig();
  if (webhookSecret && signatureHeader) {
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    if (expected !== signatureHeader) {
      throw new HttpError(400, "Invalid Razorpay webhook signature.");
    }
  }

  const event = String(eventPayload.event || "");
  const payload = eventPayload.payload as
    | {
        payout?: {
          entity?: {
            id?: string;
            status?: string;
            failure_reason?: string;
            reference_id?: string;
            notes?: { payout_request_id?: string };
          };
        };
      }
    | undefined;

  const entity = payload?.payout?.entity;
  const rzpPayoutId = entity?.id || null;
  const reqIdFromNotes = entity?.notes?.payout_request_id || null;

  let rawRow: Record<string, unknown> | null = null;
  if (rzpPayoutId) {
    rawRow = await queryOne<Record<string, unknown>>(
      `SELECT * FROM payout_requests WHERE razorpay_payout_id = $1`,
      [rzpPayoutId]
    );
  }
  if (!rawRow && reqIdFromNotes) {
    rawRow = await queryOne<Record<string, unknown>>(
      `SELECT * FROM payout_requests WHERE id = $1`,
      [reqIdFromNotes]
    );
  }

  if (!rawRow) {
    return { ok: true, event, payoutId: null, status: null, idempotent: true };
  }

  const row = normalizePayoutRow(rawRow);
  const now = nowIso();

  if (event === "payout.processed") {
    // Check if DEBIT ledger entry already exists (idempotency check)
    const existingDebit = await queryOne<Record<string, unknown>>(
      `SELECT id FROM payout_ledger WHERE payout_id = $1 AND entry_type = 'DEBIT'`,
      [row.id]
    );
    if (row.status === "COMPLETED" && existingDebit) {
      return { ok: true, event, payoutId: row.id, status: "COMPLETED", idempotent: true };
    }

    await tx(async () => {
      const freshBal = (await computeStoreBalanceInternal(row.store_id)).availableBalance;
      const afterBal = freshBal - row.amount;

      await execute(
        `UPDATE payout_requests
         SET status = 'COMPLETED',
             razorpay_payout_id = COALESCE($1, razorpay_payout_id),
             razorpay_status = 'processed',
             razorpay_response = $2,
             completed_at = COALESCE(completed_at, $3),
             failure_reason = NULL
         WHERE id = $4`,
        [rzpPayoutId, JSON.stringify(entity || eventPayload), now, row.id]
      );

      if (!existingDebit) {
        await execute(
          `INSERT INTO payout_ledger (
            payout_id, case_id, store_id, org_id, entry_type, amount,
            balance_before, balance_after, razorpay_payout_id, created_by, created_at, note
          ) VALUES ($1,$2,$3,$4,'DEBIT',$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (payout_id, entry_type) DO NOTHING`,
          [
            row.id,
            row.case_id,
            row.store_id,
            row.org_id,
            row.amount,
            freshBal,
            afterBal,
            rzpPayoutId || row.razorpay_payout_id,
            row.reviewed_by || "razorpay_webhook",
            now,
            `Webhook payout.processed for ${row.case_ref} (${rzpPayoutId || row.razorpay_payout_id})`,
          ]
        );
      }

      await audit({
        userId: row.reviewed_by,
        orgId: row.org_id,
        storeId: row.store_id,
        action: "payout.webhook.processed",
        entity: "payout_request",
        entityId: row.id,
        detail: {
          userId: row.reviewed_by || "webhook",
          role: row.reviewed_by_role || "system",
          timestamp: now,
          amount: row.amount,
          balanceBefore: freshBal,
          balanceAfter: afterBal,
          razorpayPayoutId: rzpPayoutId || row.razorpay_payout_id,
        },
      });
    });

    return { ok: true, event, payoutId: row.id, status: "COMPLETED", idempotent: false };
  }

  if (event === "payout.failed") {
    if (row.status === "FAILED") {
      return { ok: true, event, payoutId: row.id, status: "FAILED", idempotent: true };
    }
    const reason = entity?.failure_reason || "Razorpay payout failed via webhook";

    await tx(async () => {
      await execute(
        `UPDATE payout_requests
         SET status = 'FAILED',
             razorpay_payout_id = COALESCE($1, razorpay_payout_id),
             razorpay_status = 'failed',
             razorpay_response = $2,
             failure_reason = $3
         WHERE id = $4`,
        [rzpPayoutId, JSON.stringify(entity || eventPayload), reason, row.id]
      );

      await audit({
        userId: row.reviewed_by,
        orgId: row.org_id,
        storeId: row.store_id,
        action: "payout.webhook.failed",
        entity: "payout_request",
        entityId: row.id,
        detail: {
          userId: row.reviewed_by || "webhook",
          role: row.reviewed_by_role || "system",
          timestamp: now,
          amount: row.amount,
          failureReason: reason,
          balanceDebited: false,
        },
      });
    });

    return { ok: true, event, payoutId: row.id, status: "FAILED", idempotent: false };
  }

  if (event === "payout.reversed") {
    const existingReversal = await queryOne<Record<string, unknown>>(
      `SELECT id FROM payout_ledger WHERE payout_id = $1 AND entry_type = 'REVERSAL'`,
      [row.id]
    );
    if (row.status === "REVERSED" && existingReversal) {
      return { ok: true, event, payoutId: row.id, status: "REVERSED", idempotent: true };
    }

    const existingDebit = await queryOne<Record<string, unknown>>(
      `SELECT id FROM payout_ledger WHERE payout_id = $1 AND entry_type = 'DEBIT'`,
      [row.id]
    );
    const reason = entity?.failure_reason || "Razorpay payout reversed";

    await tx(async () => {
      const freshBal = (await computeStoreBalanceInternal(row.store_id)).availableBalance;
      const afterBal = existingDebit ? freshBal + row.amount : freshBal;

      await execute(
        `UPDATE payout_requests
         SET status = 'REVERSED',
             razorpay_payout_id = COALESCE($1, razorpay_payout_id),
             razorpay_status = 'reversed',
             razorpay_response = $2,
             failure_reason = $3
         WHERE id = $4`,
        [rzpPayoutId, JSON.stringify(entity || eventPayload), reason, row.id]
      );

      if (existingDebit && !existingReversal) {
        await execute(
          `INSERT INTO payout_ledger (
            payout_id, case_id, store_id, org_id, entry_type, amount,
            balance_before, balance_after, razorpay_payout_id, created_by, created_at, note
          ) VALUES ($1,$2,$3,$4,'REVERSAL',$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (payout_id, entry_type) DO NOTHING`,
          [
            row.id,
            row.case_id,
            row.store_id,
            row.org_id,
            row.amount,
            freshBal,
            afterBal,
            rzpPayoutId || row.razorpay_payout_id,
            "razorpay_webhook",
            now,
            `Webhook payout.reversed for ${row.case_ref} — store balance restored`,
          ]
        );
      }

      await audit({
        userId: row.reviewed_by,
        orgId: row.org_id,
        storeId: row.store_id,
        action: "payout.webhook.reversed",
        entity: "payout_request",
        entityId: row.id,
        detail: {
          userId: row.reviewed_by || "webhook",
          role: row.reviewed_by_role || "system",
          timestamp: now,
          amount: row.amount,
          balanceBefore: freshBal,
          balanceAfter: afterBal,
          reason,
        },
      });
    });

    return { ok: true, event, payoutId: row.id, status: "REVERSED", idempotent: false };
  }

  return { ok: true, event, payoutId: row.id, status: row.status, idempotent: true };
}
