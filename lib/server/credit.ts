import { query, queryOne, execute, nowIso, audit, tx } from "./db";
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

type LedgerRow = { id: number | string; store_id: string; case_id: string; kind: CreditEvent["kind"]; amount: number | string; note: string | null; by_user: string | null; at: string };

export async function storeEvents(storeId: string): Promise<CreditEvent[]> {
  const rows = await query<LedgerRow>(`SELECT * FROM credit_ledger WHERE store_id = $1 ORDER BY id`, [storeId]);
  return rows.map((r) => ({
    kind: r.kind,
    caseId: r.case_id,
    amount: Number(r.amount),
    at: r.at,
    note: r.note ?? undefined,
  }));
}

export async function storePolicy(store: StoreRow): Promise<CreditPolicy> {
  const s = await orgSettings(store.org_id);
  return { limit: store.credit_limit, releaseOn: s.releaseOn, warnAt: s.warnAt, maxAgeDays: s.maxAgeDays, pickupAtCount: s.pickupAtCount };
}

/** Append ledger events. Callers run this inside their own tx(). */
export async function postEvents(storeId: string, events: CreditEvent[], byUser: string | null): Promise<void> {
  for (const e of events) {
    await execute(
      `INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, by_user, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [storeId, e.caseId, e.kind, e.amount, e.note ?? null, byUser, e.at]
    );
  }
  const currentEvents = await storeEvents(storeId);
  const errs = checkLedger(currentEvents);
  if (errs.length) throw new HttpError(409, `Credit ledger check failed: ${errs[0]}`);
}

export async function heldDevices(storeId: string): Promise<(HeldDevice & { ref: string; label: string; status: string; pickupId: string | null })[]> {
  const rows = await query<{
    id: string;
    ref: string;
    trade_value: number | string;
    locked_at: string;
    status: string;
    pickup_id: string | null;
    brand: string;
    model: string;
    variant: string;
  }>(
    `SELECT c.id, c.ref, c.trade_value, c.locked_at, c.status, c.pickup_id, t.brand, t.model, c.variant
     FROM cases c LEFT JOIN trade_models t ON t.id = c.model_id
     WHERE c.store_id = $1 AND c.status IN ('locked','in_pickup') ORDER BY c.locked_at`,
    [storeId]
  );
  return rows.map((r) => ({
    caseId: r.id,
    ref: r.ref,
    value: Number(r.trade_value || 0),
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
  held: Awaited<ReturnType<typeof heldDevices>>;
  inTransit: { count: number; value: number };
  ledger: (LedgerRow & { case_ref: string | null })[] | null;
};

export async function storePayoutNetDebit(storeId: string): Promise<number> {
  try {
    const row = await queryOne<{ net: string | number | null }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount WHEN entry_type = 'REVERSAL' THEN -amount ELSE 0 END), 0) AS net
       FROM payout_ledger WHERE store_id = $1`,
      [storeId]
    );
    return Number(row?.net ?? 0);
  } catch {
    return 0;
  }
}

export async function creditSummary(u: SessionUser, storeId: string, opts: { withLedger?: boolean } = {}): Promise<CreditSummary> {
  if (u.role === "advisor") {
    throw new HttpError(403, "Store counter users are not permitted to view store balance or wallet figures.");
  }
  const store = await storeInScope(u, storeId);
  const policy = await storePolicy(store);
  const events = await storeEvents(store.id);
  const held = await heldDevices(store.id);
  const transit = await queryOne<{ n: string | number; v: string | number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(trade_value),0) v FROM cases WHERE store_id = $1 AND status = 'collected'`,
    [store.id]
  );
  const canLedger = Boolean(opts.withLedger);
  const ledger = canLedger
    ? await query<LedgerRow & { case_ref: string | null }>(
        `SELECT l.*, c.ref AS case_ref FROM credit_ledger l LEFT JOIN cases c ON c.id = l.case_id WHERE l.store_id = $1 ORDER BY l.id DESC LIMIT 200`,
        [store.id]
      )
    : null;
  const basePos = position(policy, events);
  const payoutDebit = await storePayoutNetDebit(store.id);
  const adjExposure = basePos.exposure + payoutDebit;
  const adjAvailable = policy.limit - adjExposure;
  const adjUtil = policy.limit > 0 ? Math.max(0, adjExposure / policy.limit) : adjExposure > 0 ? Infinity : 0;
  const adjState: CreditPosition["state"] =
    adjExposure > policy.limit ? "over" : adjExposure === policy.limit && policy.limit > 0 ? "full" : adjUtil >= policy.warnAt ? "warn" : "ok";

  return {
    store: { id: store.id, name: store.name, code: store.code, kind: store.kind, city: store.city },
    policy,
    position:
      payoutDebit === 0
        ? basePos
        : {
            ...basePos,
            exposure: adjExposure,
            available: adjAvailable,
            utilisation: adjUtil,
            state: adjState,
          },
    advice: pickupAdvice(policy, events, held, nowIso()),
    held,
    inTransit: { count: Number(transit?.n || 0), value: Number(transit?.v || 0) },
    ledger,
  };
}

export async function setCreditLimit(u: SessionUser, storeId: string, limit: number, reason: string): Promise<StoreRow> {
  if (!["platform", "org_admin"].includes(u.role)) throw new HttpError(403, "Only the programme admin can change a credit limit.");
  const store = await storeInScope(u, storeId);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw new HttpError(400, "Credit limit must be a whole rupee amount between 0 and ₹10 crore.");
  if ((reason || "").trim().length < 4) throw new HttpError(400, "Give a reason for the change.");
  return tx(async () => {
    await execute(`UPDATE stores SET credit_limit = $1 WHERE id = $2`, [limit, store.id]);
    await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "credit_limit.set", entity: "store", entityId: store.id, detail: { from: store.credit_limit, to: limit, reason: reason.trim() } });
    return { ...store, credit_limit: limit };
  });
}
