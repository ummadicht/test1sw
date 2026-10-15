import { db, tx, nowIso, newId, nextSeq, parseJson, audit } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { getStore, getOrg, canSeeStore, ownStore, storeInScope, orgPartnerId, type StoreRow } from "./scope";
import { postEvents } from "./credit";
import { listCases, type CaseListItem, type Clearance } from "./cases";
import {
  assertTransition,
  canPickupTransition,
  collectionEvents,
  clearanceEvents,
  type ClearanceOutcome,
  type PickupStatus,
  type CaseStatus,
} from "../domain/lifecycle";

type PickupRow = {
  id: string;
  ref: string;
  org_id: string;
  store_id: string;
  partner_id: string;
  status: PickupStatus;
  requested_by: string | null;
  requested_at: string;
  scheduled_for: string | null;
  collector_name: string | null;
  handover_by: string | null;
  collected_at: string | null;
  reconciled_at: string | null;
  settled_at: string | null;
  settlement_ref: string | null;
  settlement_amount: number | null;
  notes: string | null;
  demo: number;
};

export type PickupView = {
  id: string;
  ref: string;
  status: PickupStatus;
  orgId: string;
  orgName: string;
  storeId: string;
  storeName: string;
  storeCity: string | null;
  partnerId: string;
  partnerName: string;
  requestedAt: string;
  requestedBy: string | null;
  scheduledFor: string | null;
  collectorName: string | null;
  handoverBy: string | null;
  collectedAt: string | null;
  reconciledAt: string | null;
  settledAt: string | null;
  settlementRef: string | null;
  settlementAmount: number | null;
  notes: string | null;
  demo: boolean;
  items: (CaseListItem & { clearance: Clearance | null })[];
  totals: { devices: number; quoted: number; accepted: number; shortfall: number; verified: number };
};

function pickupRow(id: string): PickupRow | null {
  return (db().prepare(`SELECT * FROM pickups WHERE id = ?`).get(id) as PickupRow | undefined) ?? null;
}

function pickupInScope(u: SessionUser, id: string): { p: PickupRow; store: StoreRow } {
  const p = pickupRow(id);
  if (!p) throw new HttpError(404, "Pickup not found.");
  const store = getStore(p.store_id);
  if (!store || !canSeeStore(u, store)) throw new HttpError(404, "Pickup not found.");
  return { p, store };
}

function view(u: SessionUser, p: PickupRow, store: StoreRow): PickupView {
  const items = listCases(u, { pickupId: p.id, limit: 500 }).map((c) => {
    const r = db().prepare(`SELECT clearance FROM cases WHERE id = ?`).get(c.id) as { clearance: string | null };
    return { ...c, clearance: parseJson<Clearance | null>(r.clearance, null) };
  });
  const totals = items.reduce(
    (t, i) => {
      t.devices += 1;
      t.quoted += i.tradeValue ?? 0;
      if (i.clearance) {
        t.verified += 1;
        t.accepted += i.clearance.accepted;
        t.shortfall += i.clearance.shortfall;
      }
      return t;
    },
    { devices: 0, quoted: 0, accepted: 0, shortfall: 0, verified: 0 }
  );
  const requester = p.requested_by ? (db().prepare(`SELECT name FROM users WHERE id = ?`).get(p.requested_by) as { name: string } | undefined) : undefined;
  return {
    id: p.id,
    ref: p.ref,
    status: p.status,
    orgId: p.org_id,
    orgName: getOrg(p.org_id)?.name ?? "",
    storeId: store.id,
    storeName: store.name,
    storeCity: store.city,
    partnerId: p.partner_id,
    partnerName: getOrg(p.partner_id)?.name ?? "",
    requestedAt: p.requested_at,
    requestedBy: requester?.name ?? null,
    scheduledFor: p.scheduled_for,
    collectorName: p.collector_name,
    handoverBy: p.handover_by,
    collectedAt: p.collected_at,
    reconciledAt: p.reconciled_at,
    settledAt: p.settled_at,
    settlementRef: p.settlement_ref,
    settlementAmount: p.settlement_amount,
    notes: p.notes,
    demo: !!p.demo,
    items,
    totals,
  };
}

export function getPickup(u: SessionUser, id: string): PickupView {
  const { p, store } = pickupInScope(u, id);
  return view(u, p, store);
}

export function listPickups(u: SessionUser, opts: { status?: PickupStatus[] | null; storeId?: string | null } = {}): PickupView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (u.role === "advisor" || u.role === "store_manager") {
    where.push("store_id = ?");
    args.push(u.storeId);
  } else if (u.role === "org_admin") {
    where.push("org_id = ?");
    args.push(u.orgId);
  } else if (u.role === "partner") {
    where.push("partner_id = ?");
    args.push(u.orgId);
  }
  if (opts.storeId) {
    storeInScope(u, opts.storeId);
    where.push("store_id = ?");
    args.push(opts.storeId);
  }
  if (opts.status?.length) {
    where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
    args.push(...opts.status);
  }
  const rows = db()
    .prepare(`SELECT * FROM pickups ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY requested_at DESC LIMIT 200`)
    .all(...args) as PickupRow[];
  return rows.map((p) => view(u, p, getStore(p.store_id)!));
}

function setCaseStatus(id: string, from: CaseStatus, to: CaseStatus, extra: Record<string, unknown> = {}): void {
  assertTransition(from, to);
  const sets = { status: to, updated_at: nowIso(), ...extra };
  const cols = Object.keys(sets);
  const r = db()
    .prepare(`UPDATE cases SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status = ?`)
    .run(...cols.map((c) => (sets as Record<string, unknown>)[c]), id, from);
  if (r.changes !== 1) throw new HttpError(409, "A device in this pickup changed while you were working — reload.");
}

/** The store asks the partner to come and collect. Takes every phone waiting at the store unless a subset is named. */
export function requestPickup(u: SessionUser, input: { caseIds?: string[] | null; notes?: string | null; demo?: boolean } = {}): PickupView {
  if (u.role !== "store_manager") throw new HttpError(403, "The store manager books pickups.");
  const store = ownStore(u);
  const partnerId = orgPartnerId(store.org_id);
  return tx(() => {
    const waiting = db().prepare(`SELECT id FROM cases WHERE store_id = ? AND status = 'locked' ORDER BY locked_at`).all(store.id) as { id: string }[];
    const wanted = input.caseIds?.length ? waiting.filter((w) => input.caseIds!.includes(w.id)) : waiting;
    if (input.caseIds?.length && wanted.length !== new Set(input.caseIds).size)
      throw new HttpError(409, "Some of those devices are not waiting at this store.");
    if (!wanted.length) throw new HttpError(409, "No traded-in phones are waiting at this store.");
    const id = newId("pk");
    const ref = `PK-${store.code}-${String(nextSeq(`pickup:${store.id}`)).padStart(4, "0")}`;
    db()
      .prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, requested_by, requested_at, notes, demo) VALUES (?,?,?,?,?,'requested',?,?,?,?)`)
      .run(id, ref, store.org_id, store.id, partnerId, u.id, nowIso(), (input.notes || "").slice(0, 300) || null, input.demo ? 1 : 0);
    for (const w of wanted) setCaseStatus(w.id, "locked", "in_pickup", { pickup_id: id });
    audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "pickup.request", entity: "pickup", entityId: id, detail: { devices: wanted.length } });
    return getPickup(u, id);
  });
}

function movePickup(p: PickupRow, to: PickupStatus, extra: Record<string, unknown> = {}): void {
  if (!canPickupTransition(p.status, to)) throw new HttpError(409, `A pickup that is ${p.status} cannot become ${to}.`);
  const sets = { status: to, ...extra };
  const cols = Object.keys(sets);
  const r = db()
    .prepare(`UPDATE pickups SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status = ?`)
    .run(...cols.map((c) => (sets as Record<string, unknown>)[c]), p.id, p.status);
  if (r.changes !== 1) throw new HttpError(409, "This pickup changed while you were working — reload.");
}

export function schedulePickup(u: SessionUser, id: string, input: { scheduledFor: string; collectorName: string }): PickupView {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "The partner schedules collection.");
  return tx(() => {
    const { p } = pickupInScope(u, id);
    const when = String(input.scheduledFor || "");
    if (Number.isNaN(Date.parse(when))) throw new HttpError(400, "Choose a collection date and time.");
    const collector = String(input.collectorName || "").trim();
    if (collector.length < 2) throw new HttpError(400, "Name the collector the store should expect.");
    movePickup(p, "scheduled", { scheduled_for: new Date(when).toISOString(), collector_name: collector.slice(0, 80) });
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.schedule", entity: "pickup", entityId: id, detail: { when, collector } });
    return getPickup(u, id);
  });
}

export function removeFromPickup(u: SessionUser, id: string, caseId: string): PickupView {
  if (!["store_manager", "partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  return tx(() => {
    const { p } = pickupInScope(u, id);
    if (!["requested", "scheduled"].includes(p.status)) throw new HttpError(409, "Devices can only be taken off a pickup before collection.");
    const c = db().prepare(`SELECT status FROM cases WHERE id = ? AND pickup_id = ?`).get(caseId, id) as { status: CaseStatus } | undefined;
    if (!c) throw new HttpError(404, "That device is not on this pickup.");
    setCaseStatus(caseId, "in_pickup", "locked", { pickup_id: null });
    const left = db().prepare(`SELECT COUNT(*) n FROM cases WHERE pickup_id = ?`).get(id) as { n: number };
    if (left.n === 0) movePickup({ ...p }, "cancelled");
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.remove_item", entity: "pickup", entityId: id, detail: { caseId } });
    return getPickup(u, id);
  });
}

export function cancelPickup(u: SessionUser, id: string): PickupView {
  if (!["store_manager", "partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  return tx(() => {
    const { p } = pickupInScope(u, id);
    const items = db().prepare(`SELECT id FROM cases WHERE pickup_id = ? AND status = 'in_pickup'`).all(id) as { id: string }[];
    movePickup(p, "cancelled");
    for (const i of items) setCaseStatus(i.id, "in_pickup", "locked", { pickup_id: null });
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.cancel", entity: "pickup", entityId: id });
    return getPickup(u, id);
  });
}

/**
 * The handover at the store. Both sides are named: the collector who took the
 * phones and the store person who handed them over. Only the devices actually
 * handed over are marked collected; the rest go back to waiting at the store.
 * On a "collected" release point, this is the moment the credit line frees up.
 */
export function collectPickup(u: SessionUser, id: string, input: { collectedCaseIds: string[]; collectorName: string; handoverBy: string }): PickupView {
  if (!["partner", "store_manager", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const collector = String(input.collectorName || "").trim();
  const handover = String(input.handoverBy || "").trim();
  if (collector.length < 2) throw new HttpError(400, "Name the collector.");
  if (handover.length < 2) throw new HttpError(400, "Name the store person handing over.");
  if (!Array.isArray(input.collectedCaseIds) || input.collectedCaseIds.length === 0) throw new HttpError(400, "Tick the phones the collector is taking.");
  return tx(() => {
    const { p, store } = pickupInScope(u, id);
    const items = db().prepare(`SELECT id, trade_value FROM cases WHERE pickup_id = ? AND status = 'in_pickup'`).all(id) as { id: string; trade_value: number }[];
    const taking = new Set(input.collectedCaseIds);
    const unknown = [...taking].filter((cid) => !items.some((i) => i.id === cid));
    if (unknown.length) throw new HttpError(409, "Some ticked phones are not on this pickup.");
    const now = nowIso();
    const releaseOn = orgSettings(p.org_id).releaseOn;
    movePickup(p, "collected", { collected_at: now, collector_name: collector.slice(0, 80), handover_by: handover.slice(0, 80) });
    for (const i of items) {
      if (taking.has(i.id)) {
        setCaseStatus(i.id, "in_pickup", "collected");
        postEvents(store.id, collectionEvents(releaseOn, i.id, i.trade_value, now), u.id);
      } else {
        setCaseStatus(i.id, "in_pickup", "locked", { pickup_id: null });
      }
    }
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.collect", entity: "pickup", entityId: id, detail: { taken: taking.size, left: items.length - taking.size, collector, handover } });
    return getPickup(u, id);
  });
}

/** The partner's verdict on one phone, after inspection at its facility. */
export function clearItem(u: SessionUser, id: string, input: { caseId: string; outcome: ClearanceOutcome; accepted?: number; reason?: string }): PickupView {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "Only the buyback partner verifies devices.");
  const outcome = input.outcome;
  if (!["cleared", "regraded", "rejected", "not_received"].includes(outcome)) throw new HttpError(400, "Unknown outcome.");
  const reason = String(input.reason || "").trim();
  if (outcome !== "cleared" && reason.length < 6) throw new HttpError(400, "Say why — the store will see this reason against its credit line.");
  // A regrade without an amount must not silently become a ₹0 regrade (a full
  // chargeback on the store's line) — Number(undefined) is NaN, which used to fall to 0.
  const acceptedRaw = input.accepted as unknown;
  const acceptedGiven = acceptedRaw !== undefined && acceptedRaw !== null && acceptedRaw !== "" && Number.isFinite(Number(acceptedRaw));
  if (outcome === "regraded" && !acceptedGiven) throw new HttpError(400, "Enter what the partner will pay for this phone after the regrade.");
  return tx(() => {
    const { p, store } = pickupInScope(u, id);
    if (p.status !== "collected") throw new HttpError(409, "Devices are verified after collection and before the pickup is settled.");
    const c = db().prepare(`SELECT id, status, trade_value FROM cases WHERE id = ? AND pickup_id = ?`).get(input.caseId, id) as
      | { id: string; status: CaseStatus; trade_value: number }
      | undefined;
    if (!c) throw new HttpError(404, "That device is not on this pickup.");
    if (c.status !== "collected") throw new HttpError(409, "That device already has a verdict.");
    const s = orgSettings(p.org_id);
    const now = nowIso();
    const r = clearanceEvents({
      releaseOn: s.releaseOn,
      caseId: c.id,
      held: c.trade_value,
      outcome,
      // Not floored: a fractional amount reaches the domain check and is refused, rather than quietly rounded.
      accepted: acceptedGiven ? Number(acceptedRaw) : 0,
      shortfallLiability: s.shortfallLiability,
      at: now,
    });
    const clearance: Clearance = { outcome, accepted: r.accepted, shortfall: r.shortfall, reason: reason || null, by: u.name, at: now };
    setCaseStatus(c.id, "collected", outcome, { clearance: JSON.stringify(clearance), closed_at: now });
    postEvents(store.id, r.events, u.id);
    const open = db().prepare(`SELECT COUNT(*) n FROM cases WHERE pickup_id = ? AND status = 'collected'`).get(id) as { n: number };
    if (open.n === 0) movePickup(p, "reconciled", { reconciled_at: now });
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.clear_item", entity: "case", entityId: c.id, detail: clearance });
    return getPickup(u, id);
  });
}

/** The partner pays the store for everything it accepted on this pickup. */
export function settlePickup(u: SessionUser, id: string, input: { reference: string }): PickupView {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "The partner settles pickups.");
  const ref = String(input.reference || "").trim();
  if (ref.length < 4) throw new HttpError(400, "Enter the payment reference (UTR / transfer id).");
  return tx(() => {
    const { p } = pickupInScope(u, id);
    const sum = db().prepare(`SELECT COALESCE(SUM(json_extract(clearance,'$.accepted')),0) AS v FROM cases WHERE pickup_id = ?`).get(id) as { v: number };
    const now = nowIso();
    movePickup(p, "settled", { settled_at: now, settlement_ref: ref.slice(0, 60), settlement_amount: sum.v });
    db().prepare(`UPDATE cases SET settled_at = ? WHERE pickup_id = ?`).run(now, id);
    audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.settle", entity: "pickup", entityId: id, detail: { amount: sum.v, ref } });
    return getPickup(u, id);
  });
}

/**
 * Close (part of) an open chargeback: the store made the shortfall good, or the
 * partner accepted a "not received" dispute. Never more than is still open.
 */
export function recoverChargeback(u: SessionUser, caseId: string, input: { amount: number; note: string }): { ok: true; open: number } {
  const amount = Number(input.amount);
  const note = String(input.note || "").trim();
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, "Amount must be a positive whole rupee amount.");
  if (note.length < 6) throw new HttpError(400, "Say how the shortfall was settled.");
  return tx(() => {
    const c = db().prepare(`SELECT id, store_id, org_id, status FROM cases WHERE id = ?`).get(caseId) as
      | { id: string; store_id: string; org_id: string; status: CaseStatus }
      | undefined;
    if (!c) throw new HttpError(404, "Case not found.");
    const store = getStore(c.store_id)!;
    if (!canSeeStore(u, store)) throw new HttpError(404, "Case not found.");
    const allowed =
      u.role === "platform" || u.role === "org_admin" || (u.role === "partner" && c.status === "not_received");
    if (!allowed) throw new HttpError(403, "Only the programme admin (or the partner, for a not-received dispute) closes a chargeback.");
    const sums = db()
      .prepare(`SELECT COALESCE(SUM(CASE kind WHEN 'chargeback' THEN amount WHEN 'recovery' THEN -amount ELSE 0 END),0) AS open FROM credit_ledger WHERE case_id = ?`)
      .get(caseId) as { open: number };
    if (amount > sums.open) throw new HttpError(409, `Only ₹${sums.open.toLocaleString("en-IN")} is open on this case.`);
    postEvents(store.id, [{ kind: "recovery", caseId, amount, at: nowIso(), note }], u.id);
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "chargeback.recover", entity: "case", entityId: caseId, detail: { amount, note } });
    return { ok: true as const, open: sums.open - amount };
  });
}

export function openChargebacks(u: SessionUser, storeId?: string | null): { caseId: string; ref: string; storeName: string; status: CaseStatus; open: number; reason: string | null }[] {
  const rows = db()
    .prepare(
      `SELECT c.id, c.ref, c.status, c.clearance, s.name AS store_name, c.store_id,
        SUM(CASE l.kind WHEN 'chargeback' THEN l.amount WHEN 'recovery' THEN -l.amount ELSE 0 END) AS open
       FROM credit_ledger l JOIN cases c ON c.id = l.case_id JOIN stores s ON s.id = c.store_id
       WHERE l.kind IN ('chargeback','recovery') ${storeId ? "AND c.store_id = ?" : ""}
       GROUP BY c.id HAVING open > 0 ORDER BY c.updated_at DESC`
    )
    .all(...(storeId ? [storeId] : [])) as { id: string; ref: string; status: CaseStatus; clearance: string | null; store_name: string; store_id: string; open: number }[];
  return rows
    .filter((r) => canSeeStore(u, getStore(r.store_id)!))
    .map((r) => ({ caseId: r.id, ref: r.ref, storeName: r.store_name, status: r.status, open: r.open, reason: parseJson<Clearance | null>(r.clearance, null)?.reason ?? null }));
}
