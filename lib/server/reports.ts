import { query, queryOne, parseJson } from "./db";
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

export async function programmeReport(u: SessionUser, opts: { orgId?: string | null; from?: string | null; to?: string | null } = {}): Promise<{
  stores: StoreReport[];
  totals: Omit<StoreReport, "storeId" | "storeName" | "city" | "kind" | "state" | "oldestDays" | "pickupDue" | "pickupReasons" | "utilisation"> & { utilisation: number };
}> {
  if (u.role === "advisor" || u.role === "partner") throw new HttpError(403, "Reports are for managers and programme admins.");
  let stores = await storesForUser(u);
  if (opts.orgId) stores = stores.filter((s) => s.org_id === opts.orgId);
  // Date ranges are India days (IST, UTC+5:30), like the claims month — a case
  // opened at 01:00 IST belongs to that IST day, not the previous UTC one.
  const istDay = (d: string | null | undefined, end: boolean) =>
    d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00.000"}+05:30`).toISOString() : null;
  const from = istDay(opts.from, false) ?? "0000";
  const to = istDay(opts.to, true) ?? "9999";

  const out: StoreReport[] = await Promise.all(
    stores.map(async (s) => {
      const cs = await creditSummary(u, s.id);
      const f = await queryOne<{
        cases: string | number;
        quoted: string | number | null;
        repairs: string | number | null;
        upgrades: string | number | null;
        walked: string | number | null;
        cancelled: string | number | null;
        trade_total: string | number;
        bonus_total: string | number;
        new_revenue: string | number;
        avg_bp: string | number | null;
      }>(
        `SELECT
           COUNT(*) AS cases,
           SUM((status != 'draft')::int) AS quoted,
           SUM((status = 'repair_chosen')::int) AS repairs,
           SUM((status IN ('locked','in_pickup','collected','cleared','regraded','rejected','not_received'))::int) AS upgrades,
           SUM((status = 'walked_away')::int) AS walked,
           SUM((status = 'cancelled')::int) AS cancelled,
           COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN trade_value END),0) AS trade_total,
           COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN bonus_value END),0) AS bonus_total,
           COALESCE(SUM(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN ((upgrade::jsonb #>> '{price}')::numeric) END),0) AS new_revenue,
           AVG(CASE WHEN locked_at IS NOT NULL AND status != 'cancelled' THEN COALESCE(((bonus::jsonb #>> '{override,bp}')::numeric), ((bonus::jsonb #>> '{bp}')::numeric)) END) AS avg_bp
         FROM cases WHERE store_id = $1 AND created_at >= $2 AND created_at <= $3`,
        [s.id, from, to]
      );
      const repairsCount = Number(f?.repairs || 0);
      const upgradesCount = Number(f?.upgrades || 0);
      const walkedCount = Number(f?.walked || 0);
      const decided = repairsCount + upgradesCount + walkedCount;
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
          cases: Number(f?.cases || 0),
          quoted: Number(f?.quoted || 0),
          repairs: repairsCount,
          upgrades: upgradesCount,
          walked: walkedCount,
          cancelled: Number(f?.cancelled || 0),
        },
        upgradeRate: decided ? upgradesCount / decided : null,
        tradeInTotal: Number(f?.trade_total || 0),
        bonusTotal: Number(f?.bonus_total || 0),
        avgBonusBp: f?.avg_bp === null || f?.avg_bp === undefined ? null : Math.round(Number(f.avg_bp)),
        newDeviceRevenue: Number(f?.new_revenue || 0),
      };
    })
  );

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
  premium: number;
  premiumBp: number;
  premiumFundedBy: string;
  accepted: number | null;
  status: string;
};

/**
 * Every upgrade bonus and SwapUp premium given — what the store claims back from whoever funds
 * them (the campaign's funder for a bonus, the programme for a premium). Both are the programme's,
 * never the store's: a regrade never re-bases the premium and nothing here is a chargeback.
 */
export async function bonusClaims(u: SessionUser, opts: { orgId?: string | null; month?: string | null } = {}): Promise<BonusClaimRow[]> {
  if (!["platform", "org_admin", "store_manager"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const allStores = await storesForUser(u);
  const stores = allStores.filter((s) => !opts.orgId || s.org_id === opts.orgId);
  if (!stores.length) return [];
  const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : null;
  const storeIds = stores.map((s) => s.id);
  const args: unknown[] = [storeIds];
  let monthFilter = "";
  if (month) {
    args.push(month);
    monthFilter = `AND to_char(c.locked_at::timestamptz + interval '330 minutes', 'YYYY-MM') = $${args.length}`;
  }
  const rows = await query<{
    ref: string;
    locked_at: string;
    trade_value: number;
    bonus_value: number;
    bonus: string;
    upgrade: string;
    status: string;
    premium_value: number | null;
    premium_bp: number | null;
    premium_funded_by: string | null;
    clearance: string | null;
    store_name: string;
    store_code: string;
  }>(
    `SELECT c.ref, c.locked_at, c.trade_value, c.bonus_value, c.bonus, c.upgrade, c.status, c.premium_value, c.premium_bp, c.premium_funded_by, c.clearance,
            s.name AS store_name, s.code AS store_code
     FROM cases c JOIN stores s ON s.id = c.store_id
     WHERE c.store_id = ANY($1::text[]) AND c.locked_at IS NOT NULL AND c.status != 'cancelled'
       AND (COALESCE(c.bonus_value,0) > 0 OR COALESCE(c.premium_value,0) > 0)
       ${monthFilter}
     ORDER BY c.locked_at`,
    args
  );
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
      bonusBp: (r.bonus_value ?? 0) > 0 ? (b?.override?.bp ?? b?.bp ?? 0) : 0,
      bonus: r.bonus_value ?? 0,
      campaign: (r.bonus_value ?? 0) > 0 ? (b?.campaignName ?? "") : "",
      fundedBy: (r.bonus_value ?? 0) > 0 ? (b?.fundedBy ?? "") : "",
      override: b?.override ? `${b.override.by}: ${b.override.reason}` : null,
      premium: r.premium_value ?? 0,
      premiumBp: r.premium_bp ?? 0,
      premiumFundedBy: (r.premium_value ?? 0) > 0 ? (r.premium_funded_by ?? "") : "",
      accepted: r.status === "regraded" ? (parseJson<{ accepted?: number } | null>(r.clearance, null)?.accepted ?? null) : null,
      status: r.status,
    };
  });
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

/** What the partner owes and what it is doing, across the clients it serves. */
export async function partnerReport(u: SessionUser): Promise<{
  pickups: Record<string, number>;
  owed: number;
  devicesInTransit: number;
  openDisputes: number;
}> {
  if (!["partner", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const where = u.role === "partner" ? "WHERE p.partner_id = $1" : "";
  const args = u.role === "partner" ? [u.orgId] : [];
  const byStatus = await query<{ status: string; n: string | number }>(
    `SELECT p.status, COUNT(*) n FROM pickups p ${where} GROUP BY p.status`,
    args
  );
  const owed = await queryOne<{ v: string | number }>(
    `SELECT COALESCE(SUM((c.clearance::jsonb #>> '{accepted}')::numeric),0) v FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} p.status = 'reconciled'`,
    args
  );
  const transit = await queryOne<{ n: string | number }>(
    `SELECT COUNT(*) n FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} c.status = 'collected'`,
    args
  );
  const disputes = await queryOne<{ n: string | number }>(
    `SELECT COUNT(*) n FROM cases c JOIN pickups p ON p.id = c.pickup_id ${where ? where + " AND" : "WHERE"} c.status = 'not_received'`,
    args
  );
  return {
    pickups: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
    owed: Number(owed?.v || 0),
    devicesInTransit: Number(transit?.n || 0),
    openDisputes: Number(disputes?.n || 0),
  };
}

export async function orgName(id: string): Promise<string> {
  const o = await getOrg(id);
  return o?.name ?? "";
}
