import { db, parseJson } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { storesForUser, getOrg } from "./scope";
import { creditSummary } from "./credit";
import type { BonusApplied, UpgradeChoice } from "./cases";

/**
 * Programme reporting. Aggregates are computed in SQL per store, not by loading
 * every case into memory.
 */

export type StoreReport = {
  storeId: string;
  storeName: string;
  city: string | null;
  kind: string;
  limit: number;
  exposure: number;
  available: number;
  utilisation: number;
  state: string;
  waiting: number;
  oldestDays: number | null;
  pickupDue: boolean;
  pickupReasons: string[];
  chargebacksOpen: number;
  funnel: { cases: number; quoted: number; repairs: number; upgrades: number; walked: number; cancelled: number };
  upgradeRate: number | null;
  tradeInTotal: number;
  bonusTotal: number;
  avgBonusBp: number | null;
  newDeviceRevenue: number;
};

export function programmeReport(u: SessionUser, opts: { orgId?: string | null; from?: string | null; to?: string | null } = {}): {
  stores: StoreReport[];
  totals: Omit<StoreReport, "storeId" | "storeName" | "city" | "kind" | "state" | "oldestDays" | "pickupDue" | "pickupReasons" | "utilisation"> & { utilisation: number };
} {
  if (u.role === "advisor" || u.role === "partner") throw new HttpError(403, "Reports are for managers and programme admins.");
  let stores = storesForUser(u);
  if (opts.orgId) stores = stores.filter((s) => s.org_id === opts.orgId);
  // Date ranges are India days (IST, UTC+5:30), like the claims month — a case
  // opened at 01:00 IST belongs to that IST day, not the previous UTC one.
  const istDay = (d: string | null | undefined, end: boolean) =>
    d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00.000"}+05:30`).toISOString() : null;
  const from = istDay(opts.from, false) ?? "0000";
  const to = istDay(opts.to, true) ?? "9999";
  const funnelQ = db().prepare(
    `SELECT
       COUNT(*) AS cases,
       SUM(status != 'draft') AS quoted,
       SUM(status = 'repair_chosen') AS repairs,
       SUM(status IN ('locked','in_pickup','collected','cleared','regraded','rejected','not_received')) AS upgrades,
       SUM(status = 'walked_away') AS walked,
       SUM(status = 'cancelled') AS cancelled,
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN trade_value END),0) AS trade_total,
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN bonus_value END),0) AS bonus_total,
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN json_extract(upgrade,'$.price') END),0) AS new_revenue,
       AVG(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN COALESCE(json_extract(bonus,'$.override.bp'), json_extract(bonus,'$.bp')) END) AS avg_bp
     FROM cases WHERE store_id = ? AND created_at >= ? AND created_at <= ?`
  );
  const out: StoreReport[] = stores.map((s) => {
    const cs = creditSummary(u, s.id);
    const f = funnelQ.get(s.id, from, to) as {
      cases: number;
      quoted: number | null;
      repairs: number | null;
      upgrades: number | null;
      walked: number | null;
      cancelled: number | null;
      trade_total: number;
      bonus_total: number;
      new_revenue: number;
      avg_bp: number | null;
    };
    const decided = (f.repairs ?? 0) + (f.upgrades ?? 0) + (f.walked ?? 0);
    return {
      storeId: s.id,
      storeName: s.name,
      city: s.city,
      kind: s.kind,
      limit: cs.position.limit,
      exposure: cs.position.exposure,
      available: cs.position.available,
      utilisation: cs.position.utilisation,
      state: cs.position.state,
      waiting: cs.held.length,
      oldestDays: cs.advice.oldestDays,
      pickupDue: cs.advice.due,
      pickupReasons: cs.advice.reasons,
      chargebacksOpen: cs.position.chargebacksOpen,
      funnel: {
        cases: f.cases,
        quoted: f.quoted ?? 0,
        repairs: f.repairs ?? 0,
        upgrades: f.upgrades ?? 0,
        walked: f.walked ?? 0,
        cancelled: f.cancelled ?? 0,
      },
      upgradeRate: decided ? (f.upgrades ?? 0) / decided : null,
      tradeInTotal: f.trade_total,
      bonusTotal: f.bonus_total,
      avgBonusBp: f.avg_bp === null ? null : Math.round(f.avg_bp),
      newDeviceRevenue: f.new_revenue,
    };
  });
  const sum = (k: (r: StoreReport) => number) => out.reduce((t, r) => t + k(r), 0);
  const limit = sum((r) => r.limit);
  const exposure = sum((r) => r.exposure);
  const repairs = sum((r) => r.funnel.repairs);
  const upgrades = sum((r) => r.funnel.upgrades);
  const walked = sum((r) => r.funnel.walked);
  const bonusWeighted = out.filter((r) => r.avgBonusBp !== null);
  return {
    stores: out,
    totals: {
      limit,
      exposure,
      available: limit - exposure,
      utilisation: limit ? exposure / limit : 0,
      waiting: sum((r) => r.waiting),
      chargebacksOpen: sum((r) => r.chargebacksOpen),
      funnel: {
        cases: sum((r) => r.funnel.cases),
        quoted: sum((r) => r.funnel.quoted),
        repairs,
        upgrades,
        walked,
        cancelled: sum((r) => r.funnel.cancelled),
      },
      upgradeRate: repairs + upgrades + walked ? upgrades / (repairs + upgrades + walked) : null,
      tradeInTotal: sum((r) => r.tradeInTotal),
      bonusTotal: sum((r) => r.bonusTotal),
      avgBonusBp: bonusWeighted.length
        ? Math.round(bonusWeighted.reduce((t, r) => t + (r.avgBonusBp ?? 0) * r.funnel.upgrades, 0) / Math.max(1, bonusWeighted.reduce((t, r) => t + r.funnel.upgrades, 0)))
        : null,
      newDeviceRevenue: sum((r) => r.newDeviceRevenue),
    },
  };
}

export type BonusClaimRow = {
  caseRef: string;
  storeName: string;
  storeCode: string;
  lockedAt: string;
  newDevice: string;
  newPrice: number;
  tradeValue: number;
  bonusBp: number;
  bonus: number;
  campaign: string;
  fundedBy: string;
  override: string | null;
  status: string;
};

/** Every upgrade bonus given — what the store claims back from whoever funds the campaign. */
export function bonusClaims(u: SessionUser, opts: { orgId?: string | null; month?: string | null } = {}): BonusClaimRow[] {
  if (!["platform", "org_admin", "store_manager"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const stores = storesForUser(u).filter((s) => !opts.orgId || s.org_id === opts.orgId);
  if (!stores.length) return [];
  // Claim months are India months (IST, UTC+5:30) — the claims page and CSV pick
  // the month in IST, so a trade-in locked at 01:00 IST on the 1st is that month's.
  const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : null;
  const rows = db()
    .prepare(
      `SELECT c.ref, c.locked_at, c.trade_value, c.bonus_value, c.bonus, c.upgrade, c.status, s.name AS store_name, s.code AS store_code
       FROM cases c JOIN stores s ON s.id = c.store_id
       WHERE c.store_id IN (${stores.map(() => "?").join(",")}) AND c.locked_at IS NOT NULL AND c.status != 'cancelled' AND COALESCE(c.bonus_value,0) > 0
       ${month ? "AND substr(datetime(c.locked_at, '+330 minutes'),1,7) = ?" : ""}
       ORDER BY c.locked_at`
    )
    .all(...stores.map((s) => s.id), ...(month ? [month] : [])) as {
    ref: string;
    locked_at: string;
    trade_value: number;
    bonus_value: number;
    bonus: string;
    upgrade: string;
    status: string;
    store_name: string;
    store_code: string;
  }[];
  return rows.map((r) => {
    const b = parseJson<BonusApplied | null>(r.bonus, null);
    const up = parseJson<UpgradeChoice | null>(r.upgrade, null);
    return {
      caseRef: r.ref,
      storeName: r.store_name,
      storeCode: r.store_code,
      lockedAt: r.locked_at,
      newDevice: up?.label ?? "",
      newPrice: up?.price ?? 0,
      tradeValue: r.trade_value,
      bonusBp: b?.override?.bp ?? b?.bp ?? 0,
      bonus: r.bonus_value,
      campaign: b?.campaignName ?? "",
      fundedBy: b?.fundedBy ?? "",
      override: b?.override ? `${b.override.by}: ${b.override.reason}` : null,
      status: r.status,
    };
  });
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection as well as quoting.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

/** What the partner owes and what it is doing, across the clients it serves. */
export function partnerReport(u: SessionUser): {
  pickups: Record<string, number>;
  owed: number;
  devicesInTransit: number;
  openDisputes: number;
} {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const where = u.role === "partner" ? "WHERE p.partner_id = ?" : "";
  const args = u.role === "partner" ? [u.orgId] : [];
  const byStatus = db().prepare(`SELECT p.status, COUNT(*) n FROM pickups p ${where} GROUP BY p.status`).all(...args) as { status: string; n: number }[];
  const owed = db()
    .prepare(
      `SELECT COALESCE(SUM(json_extract(c.clearance,'$.accepted')),0) v FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} p.status = 'reconciled'`
    )
    .get(...args) as { v: number };
  const transit = db()
    .prepare(`SELECT COUNT(*) n FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} c.status = 'collected'`)
    .get(...args) as { n: number };
  const disputes = db()
    .prepare(`SELECT COUNT(*) n FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} c.status = 'not_received'`)
    .get(...args) as { n: number };
  return { pickups: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), owed: owed.v, devicesInTransit: transit.n, openDisputes: disputes.n };
}

export function orgName(id: string): string {
  return getOrg(id)?.name ?? "";
}
