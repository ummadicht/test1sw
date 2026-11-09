import { query, queryOne, execute, tx, nowIso, newId, nextSeq, parseJson, audit } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { getStore, getOrg, canSeeStore, ownStore, storeInScope, orgPartnerId, type StoreRow } from "./scope";
import { postEvents } from "./credit";
import { listCases, type CaseListItem, type Clearance } from "./cases";
import { pickupGrading } from "./gradingReport";
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
  items: (CaseListItem & { clearance: Clearance | null; grading: { label: string; final: boolean; version: number; path: string } | null })[];
  totals: { devices: number; quoted: number; accepted: number; shortfall: number; verified: number };
};

async function pickupRow(id: string): Promise<PickupRow | null> {
  return queryOne<PickupRow>(`SELECT * FROM pickups WHERE id = $1`, [id]);
}

async function pickupInScope(u: SessionUser, id: string): Promise<{ p: PickupRow; store: StoreRow }> {
  const p = await pickupRow(id);
  if (!p) throw new HttpError(404, "Pickup not found.");
  const store = await getStore(p.store_id);
  if (!store || !(await canSeeStore(u, store))) throw new HttpError(404, "Pickup not found.");
  return { p, store };
}

async function view(u: SessionUser, p: PickupRow, store: StoreRow): Promise<PickupView> {
  const rawCases = await listCases(u, { pickupId: p.id, limit: 500 });
  const items = await Promise.all(
    rawCases.map(async (c) => {
      const r = await queryOne<{ clearance: string | null }>(`SELECT clearance FROM cases WHERE id = $1`, [c.id]);
      const grading = await pickupGrading(c.id);
      return { ...c, clearance: parseJson<Clearance | null>(r?.clearance, null), grading };
    })
  );
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
  const requester = p.requested_by
    ? await queryOne<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [p.requested_by])
    : undefined;
  const org = await getOrg(p.org_id);
  const partner = await getOrg(p.partner_id);
  return {
    id: p.id,
    ref: p.ref,
    status: p.status,
    orgId: p.org_id,
    orgName: org?.name ?? "",
    storeId: store.id,
    storeName: store.name,
    storeCity: store.city,
    partnerId: p.partner_id,
    partnerName: partner?.name ?? "",
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

export async function getPickup(u: SessionUser, id: string): Promise<PickupView> {
  const { p, store } = await pickupInScope(u, id);
  return view(u, p, store);
}

export async function listPickups(u: SessionUser, opts: { status?: PickupStatus[] | null; storeId?: string | null } = {}): Promise<PickupView[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (u.role === "advisor" || u.role === "store_manager") {
    args.push(u.storeId);
    where.push(`store_id = $${args.length}`);
  } else if (u.role === "org_admin") {
    args.push(u.orgId);
    where.push(`org_id = $${args.length}`);
  } else if (u.role === "partner") {
    args.push(u.orgId);
    where.push(`partner_id = $${args.length}`);
  }
  if (opts.storeId) {
    await storeInScope(u, opts.storeId);
    args.push(opts.storeId);
    where.push(`store_id = $${args.length}`);
  }
  if (opts.status?.length) {
    args.push(opts.status);
    where.push(`status = ANY($${args.length}::text[])`);
  }
  const rows = await query<PickupRow>(
    `SELECT * FROM pickups ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY requested_at DESC LIMIT 200`,
    args
  );
  return Promise.all(rows.map(async (p) => view(u, p, (await getStore(p.store_id))!)));
}

async function setCaseStatus(id: string, from: CaseStatus, to: CaseStatus, extra: Record<string, unknown> = {}): Promise<void> {
  assertTransition(from, to);
  const sets: Record<string, unknown> = { status: to, updated_at: nowIso(), ...extra };
  const cols = Object.keys(sets);
  const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const params = cols.map((c) => sets[c]);
  params.push(id, from);
  const r = await execute(
    `UPDATE cases SET ${setClauses} WHERE id = $${params.length - 1} AND status = $${params.length}`,
    params
  );
  if (r.rowCount !== 1) throw new HttpError(409, "A device in this pickup changed — reload.");
}

/** The store asks the partner to come and collect. Takes every phone waiting at the store unless a subset is named. */
export async function requestPickup(u: SessionUser, input: { caseIds?: string[] | null; notes?: string | null; demo?: boolean } = {}): Promise<PickupView> {
  if (u.role !== "store_manager") throw new HttpError(403, "The store manager books pickups.");
  const store = await ownStore(u);
  const partnerId = await orgPartnerId(store.org_id);
  return tx(async () => {
    const waiting = await query<{ id: string }>(`SELECT id FROM cases WHERE store_id = $1 AND status = 'locked' ORDER BY locked_at`, [store.id]);
    const wanted = input.caseIds?.length ? waiting.filter((w) => input.caseIds!.includes(w.id)) : waiting;
    if (input.caseIds?.length && wanted.length !== new Set(input.caseIds).size)
      throw new HttpError(409, "Some of those devices are not waiting at this store.");
    if (!wanted.length) throw new HttpError(409, "No traded-in phones are waiting at this store.");
    const id = newId("pk");
    const seq = await nextSeq(`pickup:${store.id}`);
    const ref = `PK-${store.code}-${String(seq).padStart(4, "0")}`;
    await execute(
      `INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, requested_by, requested_at, notes, demo) VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9)`,
      [id, ref, store.org_id, store.id, partnerId, u.id, nowIso(), (input.notes || "").slice(0, 300) || null, input.demo ? 1 : 0]
    );
    for (const w of wanted) await setCaseStatus(w.id, "locked", "in_pickup", { pickup_id: id });
    await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "pickup.request", entity: "pickup", entityId: id, detail: { devices: wanted.length } });
    return getPickup(u, id);
  });
}

async function movePickup(p: PickupRow, to: PickupStatus, extra: Record<string, unknown> = {}): Promise<void> {
  if (!canPickupTransition(p.status, to)) throw new HttpError(409, `A pickup that is ${p.status} cannot become ${to}.`);
  const sets: Record<string, unknown> = { status: to, ...extra };
  const cols = Object.keys(sets);
  const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const params = cols.map((c) => sets[c]);
  params.push(p.id, p.status);
  const r = await execute(
    `UPDATE pickups SET ${setClauses} WHERE id = $${params.length - 1} AND status = $${params.length}`,
    params
  );
  if (r.rowCount !== 1) throw new HttpError(409, "This pickup changed — reload.");
}

export async function schedulePickup(u: SessionUser, id: string, input: { scheduledFor: string; collectorName: string }): Promise<PickupView> {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "The partner schedules collection.");
  return tx(async () => {
    const { p } = await pickupInScope(u, id);
    const when = String(input.scheduledFor || "");
    if (Number.isNaN(Date.parse(when))) throw new HttpError(400, "Choose a collection date and time.");
    const collector = String(input.collectorName || "").trim();
    if (collector.length < 2) throw new HttpError(400, "Name the collector the store should expect.");
    await movePickup(p, "scheduled", { scheduled_for: new Date(when).toISOString(), collector_name: collector.slice(0, 80) });
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.schedule", entity: "pickup", entityId: id, detail: { when, collector } });
    return getPickup(u, id);
  });
}

export async function removeFromPickup(u: SessionUser, id: string, caseId: string): Promise<PickupView> {
  if (!["store_manager", "partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  return tx(async () => {
    const { p } = await pickupInScope(u, id);
    if (!["requested", "scheduled"].includes(p.status)) throw new HttpError(409, "Devices can only be taken off a pickup before collection.");
    const c = await queryOne<{ status: CaseStatus }>(`SELECT status FROM cases WHERE id = $1 AND pickup_id = $2`, [caseId, id]);
    if (!c) throw new HttpError(404, "That device is not on this pickup.");
    await setCaseStatus(caseId, "in_pickup", "locked", { pickup_id: null });
    const left = await queryOne<{ n: string | number }>(`SELECT COUNT(*) n FROM cases WHERE pickup_id = $1`, [id]);
    if (Number(left?.n || 0) === 0) await movePickup({ ...p }, "cancelled");
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.remove_item", entity: "pickup", entityId: id, detail: { caseId } });
    return getPickup(u, id);
  });
}

export async function cancelPickup(u: SessionUser, id: string): Promise<PickupView> {
  if (!["store_manager", "partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  return tx(async () => {
    const { p } = await pickupInScope(u, id);
    const items = await query<{ id: string }>(`SELECT id FROM cases WHERE pickup_id = $1 AND status = 'in_pickup'`, [id]);
    await movePickup(p, "cancelled");
    for (const i of items) await setCaseStatus(i.id, "in_pickup", "locked", { pickup_id: null });
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.cancel", entity: "pickup", entityId: id });
    return getPickup(u, id);
  });
}

export async function collectPickup(u: SessionUser, id: string, input: { collectedCaseIds: string[]; collectorName: string; handoverBy: string }): Promise<PickupView> {
  if (!["partner", "store_manager", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const collector = String(input.collectorName || "").trim();
  const handover = String(input.handoverBy || "").trim();
  if (collector.length < 2) throw new HttpError(400, "Name the collector.");
  if (handover.length < 2) throw new HttpError(400, "Name the store person handing over.");
  if (!Array.isArray(input.collectedCaseIds) || input.collectedCaseIds.length === 0) throw new HttpError(400, "Tick the phones the collector is taking.");
  return tx(async () => {
    const { p, store } = await pickupInScope(u, id);
    const items = await query<{ id: string; trade_value: number }>(`SELECT id, trade_value FROM cases WHERE pickup_id = $1 AND status = 'in_pickup'`, [id]);
    const taking = new Set(input.collectedCaseIds);
    const unknown = [...taking].filter((cid) => !items.some((i) => i.id === cid));
    if (unknown.length) throw new HttpError(409, "Some ticked phones are not on this pickup.");
    const now = nowIso();
    const settings = await orgSettings(p.org_id);
    const releaseOn = settings.releaseOn;
    await movePickup(p, "collected", { collected_at: now, collector_name: collector.slice(0, 80), handover_by: handover.slice(0, 80) });
    for (const i of items) {
      if (taking.has(i.id)) {
        await setCaseStatus(i.id, "in_pickup", "collected");
        await postEvents(store.id, collectionEvents(releaseOn, i.id, i.trade_value, now), u.id);
      } else {
        await setCaseStatus(i.id, "in_pickup", "locked", { pickup_id: null });
      }
    }
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.collect", entity: "pickup", entityId: id, detail: { taken: taking.size, left: items.length - taking.size, collector, handover } });
    return getPickup(u, id);
  });
}

export async function clearItem(u: SessionUser, id: string, input: { caseId: string; outcome: ClearanceOutcome; accepted?: number; reason?: string }): Promise<PickupView> {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "Only the buyback partner verifies devices.");
  const outcome = input.outcome;
  if (!["cleared", "regraded", "rejected", "not_received"].includes(outcome)) throw new HttpError(400, "Unknown outcome.");
  const reason = String(input.reason || "").trim();
  if (outcome !== "cleared" && reason.length < 6) throw new HttpError(400, "Say why — the store sees this reason.");
  const acceptedRaw = input.accepted as unknown;
  const acceptedGiven = acceptedRaw !== undefined && acceptedRaw !== null && acceptedRaw !== "" && Number.isFinite(Number(acceptedRaw));
  if (outcome === "regraded" && !acceptedGiven) throw new HttpError(400, "Enter what the partner pays after the regrade.");
  return tx(async () => {
    const { p, store } = await pickupInScope(u, id);
    if (p.status !== "collected") throw new HttpError(409, "Verify devices after collection, before settling.");
    const c = await queryOne<{ id: string; status: CaseStatus; trade_value: number }>(`SELECT id, status, trade_value FROM cases WHERE id = $1 AND pickup_id = $2`, [input.caseId, id]);
    if (!c) throw new HttpError(404, "That device is not on this pickup.");
    if (c.status !== "collected") throw new HttpError(409, "That device already has a verdict.");
    const s = await orgSettings(p.org_id);
    const now = nowIso();
    const r = clearanceEvents({
      releaseOn: s.releaseOn,
      caseId: c.id,
      held: c.trade_value,
      outcome,
      accepted: acceptedGiven ? Number(acceptedRaw) : 0,
      shortfallLiability: s.shortfallLiability,
      at: now,
    });
    const clearance: Clearance = { outcome, accepted: r.accepted, shortfall: r.shortfall, reason: reason || null, by: u.name, at: now };
    await setCaseStatus(c.id, "collected", outcome, { clearance: JSON.stringify(clearance), closed_at: now });
    await postEvents(store.id, r.events, u.id);
    const open = await queryOne<{ n: string | number }>(`SELECT COUNT(*) n FROM cases WHERE pickup_id = $1 AND status = 'collected'`, [id]);
    if (Number(open?.n || 0) === 0) await movePickup(p, "reconciled", { reconciled_at: now });
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.clear_item", entity: "case", entityId: c.id, detail: clearance });
    return getPickup(u, id);
  });
}

export async function settlePickup(u: SessionUser, id: string, input: { reference: string }): Promise<PickupView> {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "The partner settles pickups.");
  const ref = String(input.reference || "").trim();
  if (ref.length < 4) throw new HttpError(400, "Enter the payment reference (UTR / transfer id).");
  return tx(async () => {
    const { p } = await pickupInScope(u, id);
    const sum = await queryOne<{ v: string | number }>(`SELECT COALESCE(SUM((clearance::jsonb #>> '{accepted}')::numeric),0) AS v FROM cases WHERE pickup_id = $1`, [id]);
    const acceptedVal = Number(sum?.v || 0);
    const now = nowIso();
    await movePickup(p, "settled", { settled_at: now, settlement_ref: ref.slice(0, 60), settlement_amount: acceptedVal });
    await execute(`UPDATE cases SET settled_at = $1 WHERE pickup_id = $2`, [now, id]);
    await audit({ userId: u.id, orgId: p.org_id, storeId: p.store_id, action: "pickup.settle", entity: "pickup", entityId: id, detail: { amount: acceptedVal, ref } });
    return getPickup(u, id);
  });
}

export async function recoverChargeback(u: SessionUser, caseId: string, input: { amount: number; note: string }): Promise<{ ok: true; open: number }> {
  const amount = Number(input.amount);
  const note = String(input.note || "").trim();
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, "Amount must be a positive whole rupee amount.");
  if (note.length < 6) throw new HttpError(400, "Say how the shortfall was settled.");
  return tx(async () => {
    const c = await queryOne<{ id: string; store_id: string; org_id: string; status: CaseStatus }>(`SELECT id, store_id, org_id, status FROM cases WHERE id = $1`, [caseId]);
    if (!c) throw new HttpError(404, "Case not found.");
    const store = (await getStore(c.store_id))!;
    if (!(await canSeeStore(u, store))) throw new HttpError(404, "Case not found.");
    const allowed =
      u.role === "platform" || u.role === "org_admin" || (u.role === "partner" && c.status === "not_received");
    if (!allowed) throw new HttpError(403, "Only the programme admin closes this chargeback.");
    const sums = await queryOne<{ open: string | number }>(
      `SELECT COALESCE(SUM(CASE kind WHEN 'chargeback' THEN amount WHEN 'recovery' THEN -amount ELSE 0 END),0) AS open FROM credit_ledger WHERE case_id = $1`,
      [caseId]
    );
    const openVal = Number(sums?.open || 0);
    if (amount > openVal) throw new HttpError(409, `Only ₹${openVal.toLocaleString("en-IN")} is open on this case.`);
    await postEvents(store.id, [{ kind: "recovery", caseId, amount, at: nowIso(), note }], u.id);
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "chargeback.recover", entity: "case", entityId: caseId, detail: { amount, note } });
    return { ok: true as const, open: openVal - amount };
  });
}

export async function openChargebacks(u: SessionUser, storeId?: string | null): Promise<{ caseId: string; ref: string; storeName: string; status: CaseStatus; open: number; reason: string | null }[]> {
  const rows = await query<{ id: string; ref: string; status: CaseStatus; clearance: string | null; store_name: string; store_id: string; open: string | number }>(
    `SELECT c.id, c.ref, c.status, c.clearance, s.name AS store_name, c.store_id,
      SUM(CASE l.kind WHEN 'chargeback' THEN l.amount WHEN 'recovery' THEN -l.amount ELSE 0 END) AS open
     FROM credit_ledger l JOIN cases c ON c.id = l.case_id JOIN stores s ON s.id = c.store_id
     WHERE l.kind IN ('chargeback','recovery') ${storeId ? "AND c.store_id = $1" : ""}
     GROUP BY c.id, c.ref, c.status, c.clearance, s.name, c.store_id HAVING SUM(CASE l.kind WHEN 'chargeback' THEN l.amount WHEN 'recovery' THEN -l.amount ELSE 0 END) > 0 ORDER BY c.updated_at DESC`,
    storeId ? [storeId] : []
  );
  const filtered = await Promise.all(
    rows.map(async (r) => {
      const store = await getStore(r.store_id);
      if (!store || !(await canSeeStore(u, store))) return null;
      return {
        caseId: r.id,
        ref: r.ref,
        storeName: r.store_name,
        status: r.status,
        open: Number(r.open),
        reason: parseJson<Clearance | null>(r.clearance, null)?.reason ?? null,
      };
    })
  );
  return filtered.filter((x): x is NonNullable<typeof x> => x !== null);
}
