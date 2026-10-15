import { db, nowIso, audit, tx } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { storeInScope, type StoreRow } from "./scope";
import {
  position,
  pickupAdvice,
  checkLedger,
  type CreditEvent,
  type CreditPolicy,
  type CreditPosition,
  type PickupAdvice,
  type HeldDevice,
} from "../domain/credit";

type LedgerRow = { id: number; store_id: string; case_id: string; kind: CreditEvent["kind"]; amount: number; note: string | null; by_user: string | null; at: string };

export function storeEvents(storeId: string): CreditEvent[] {
  return (db().prepare(`SELECT * FROM credit_ledger WHERE store_id = ? ORDER BY id`).all(storeId) as LedgerRow[]).map((r) => ({
    kind: r.kind,
    caseId: r.case_id,
    amount: r.amount,
    at: r.at,
    note: r.note ?? undefined,
  }));
}

export function storePolicy(store: StoreRow): CreditPolicy {
  const s = orgSettings(store.org_id);
  return { limit: store.credit_limit, releaseOn: s.releaseOn, warnAt: s.warnAt, maxAgeDays: s.maxAgeDays, pickupAtCount: s.pickupAtCount };
}

/** Append ledger events. Callers run this inside their own tx(). */
export function postEvents(storeId: string, events: CreditEvent[], byUser: string | null): void {
  const ins = db().prepare(`INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, by_user, at) VALUES (?,?,?,?,?,?,?)`);
  for (const e of events) ins.run(storeId, e.caseId, e.kind, e.amount, e.note ?? null, byUser, e.at);
  // Defence in depth: the domain promises these invariants; refuse to commit a ledger that breaks them.
  const errs = checkLedger(storeEvents(storeId));
  if (errs.length) throw new HttpError(409, `Credit ledger check failed: ${errs[0]}`);
}

export function heldDevices(storeId: string): (HeldDevice & { ref: string; label: string; status: string; pickupId: string | null })[] {
  const rows = db()
    .prepare(
      `SELECT c.id, c.ref, c.trade_value, c.locked_at, c.status, c.pickup_id, t.brand, t.model, c.variant
       FROM cases c LEFT JOIN trade_models t ON t.id = c.model_id
       WHERE c.store_id = ? AND c.status IN ('locked','in_pickup') ORDER BY c.locked_at`
    )
    .all(storeId) as {
    id: string;
    ref: string;
    trade_value: number;
    locked_at: string;
    status: string;
    pickup_id: string | null;
    brand: string;
    model: string;
    variant: string;
  }[];
  return rows.map((r) => ({
    caseId: r.id,
    ref: r.ref,
    value: r.trade_value,
    heldSince: r.locked_at,
    status: r.status,
    pickupId: r.pickup_id,
    label: `${r.brand} ${r.model} ${r.variant ?? ""}`.trim(),
  }));
}

export type CreditSummary = {
  store: { id: string; name: string; code: string; kind: string; city: string | null };
  policy: CreditPolicy;
  position: CreditPosition;
  advice: PickupAdvice;
  held: ReturnType<typeof heldDevices>;
  inTransit: { count: number; value: number };
  ledger: (LedgerRow & { case_ref: string | null })[] | null;
};

export function creditSummary(u: SessionUser, storeId: string, opts: { withLedger?: boolean } = {}): CreditSummary {
  const store = storeInScope(u, storeId);
  const policy = storePolicy(store);
  const events = storeEvents(store.id);
  const held = heldDevices(store.id);
  const transit = db()
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(trade_value),0) v FROM cases WHERE store_id = ? AND status = 'collected'`)
    .get(store.id) as { n: number; v: number };
  // The full ledger is a manager's view; an advisor sees the meter only.
  const canLedger = opts.withLedger && u.role !== "advisor";
  const ledger = canLedger
    ? (db()
        .prepare(
          `SELECT l.*, c.ref AS case_ref FROM credit_ledger l LEFT JOIN cases c ON c.id = l.case_id WHERE l.store_id = ? ORDER BY l.id DESC LIMIT 200`
        )
        .all(store.id) as (LedgerRow & { case_ref: string | null })[])
    : null;
  return {
    store: { id: store.id, name: store.name, code: store.code, kind: store.kind, city: store.city },
    policy,
    position: position(policy, events),
    advice: pickupAdvice(policy, events, held, nowIso()),
    held,
    inTransit: { count: transit.n, value: transit.v },
    ledger,
  };
}

export function setCreditLimit(u: SessionUser, storeId: string, limit: number, reason: string): StoreRow {
  if (!["platform", "org_admin"].includes(u.role)) throw new HttpError(403, "Only the programme admin can change a credit limit.");
  const store = storeInScope(u, storeId);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw new HttpError(400, "Credit limit must be a whole rupee amount between 0 and ₹10 crore.");
  if ((reason || "").trim().length < 4) throw new HttpError(400, "Give a reason for the change.");
  return tx(() => {
    db().prepare(`UPDATE stores SET credit_limit = ? WHERE id = ?`).run(limit, store.id);
    audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "credit_limit.set", entity: "store", entityId: store.id, detail: { from: store.credit_limit, to: limit, reason: reason.trim() } });
    return { ...store, credit_limit: limit };
  });
}
