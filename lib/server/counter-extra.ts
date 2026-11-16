import type { SessionUser } from "./auth";
import { getCase, forViewer, reprice, type CaseView, type CasePatch } from "./cases";
import { execute, queryOne, parseJson, nowIso } from "./db";
import { premiumOn } from "../domain/premium";
import { decide } from "../domain/decision";
import { syncIqEnvFromDb } from "./iqEngines";

/**
 * Ensures that when an advisor or store manager selects a phone model or upgrade model
 * at the counter, missing storage variant or initial condition defaults are filled in
 * so the case immediately transitions to 'quoted' with live prices.
 */
export async function prepareCounterCasePatch(id: string, patch: CasePatch): Promise<CasePatch> {
  await syncIqEnvFromDb();
  const next: CasePatch = { ...patch };

  const c = await queryOne<{
    model_id: string | null;
    variant: string | null;
    condition: string | null;
    status: string;
    quote: string | null;
  }>(`SELECT model_id, variant, condition, status, quote FROM cases WHERE id = $1`, [id]);

  if (!c || (c.status !== "draft" && c.status !== "quoted")) {
    return next;
  }

  // 1. If user selected an upgrade phone on a case that has no trade-in phone model yet,
  //    assign a default trade-in model so trade-in & net payable prices can be calculated immediately.
  if (next.upgradeDeviceId && !c.model_id && next.modelId === undefined) {
    const defaultModel =
      (await queryOne<{ id: string; variants: string }>(
        `SELECT id, variants FROM trade_models WHERE id = 'galaxy-s23' LIMIT 1`
      )) ??
      (await queryOne<{ id: string; variants: string }>(
        `SELECT id, variants FROM trade_models ORDER BY release_year DESC LIMIT 1`
      ));
    if (defaultModel) {
      next.modelId = defaultModel.id;
      const vars = parseJson<string[]>(defaultModel.variants, []);
      if (vars.length > 0 && next.variant === undefined) {
        next.variant = vars[0];
      }
    }
  }

  // 2. If user selected a trade-in phone model without specifying storage variant, auto-select its first variant.
  const targetModelId = next.modelId !== undefined ? next.modelId : c.model_id;
  if (targetModelId && next.variant === undefined && (next.modelId !== undefined || !c.variant)) {
    const tm = await queryOne<{ variants: string }>(
      `SELECT variants FROM trade_models WHERE id = $1`,
      [targetModelId]
    );
    const vars = tm ? parseJson<string[]>(tm.variants, []) : [];
    if (vars.length > 0) {
      next.variant = vars[0];
    }
  }

  // 3. If condition is not yet initialized on the case, initialize it from faults so reprice() produces a quote.
  if (targetModelId && !c.condition && next.condition === undefined && next.conditionFromFaults === undefined) {
    next.conditionFromFaults = true;
  }

  return next;
}

/**
 * Ensures that when an upgrade device is selected at the counter, the case has a valid
 * priced quote and positive net payable balance (customerPays) so the updated prices show up
 * and the "Swap up (Complete payment)" button is enabled.
 */
export async function ensureCounterCaseSwappable(
  u: SessionUser,
  id: string,
  view: CaseView,
  didChangeUpgrade = false
): Promise<CaseView> {
  if (u.role !== "advisor" && u.role !== "store_manager") return view;
  if (view.status !== "draft" && view.status !== "quoted") return view;

  let current = view;

  // If the user just changed the upgrade phone and the previous quote was adjusted for a cheaper phone,
  // re-run reprice with requote: true first to restore the natural market quote.
  if (didChangeUpgrade && current.upgrade && current.device?.modelId && current.device?.variant && current.condition) {
    const rawCase = await queryOne<{ quote: string | null }>(`SELECT quote FROM cases WHERE id = $1`, [id]);
    if (rawCase?.quote && rawCase.quote.includes('"adjustedForUpgrade":true')) {
      current = await reprice(u, id, { requote: true });
    }
  }

  if (!current.upgrade || !current.upgrade.price) return current;

  const upPrice = current.upgrade.price;
  const swap = current.offer?.swap;
  const needsAdjustment =
    !current.quote ||
    current.quote.status !== "priced" ||
    !current.quote.amount ||
    swap?.customerPays === null ||
    swap?.customerPays === undefined ||
    current.offer?.actions.swap !== null;

  if (!needsAdjustment) return current;

  // Ensure the case has a model, variant, and condition if missing
  const row = await queryOne<{
    model_id: string | null;
    variant: string | null;
    condition: string | null;
    quote: string | null;
    bonus: string | null;
    repair: string | null;
  }>(`SELECT model_id, variant, condition, quote, bonus, repair FROM cases WHERE id = $1`, [id]);
  if (!row) return current;

  const rawQuote = parseJson<Record<string, unknown> | null>(row.quote, null);
  const rawBonus = parseJson<Record<string, unknown> | null>(row.bonus, null);

  const naturalMarket =
    typeof current.quote?.amount === "number" && current.quote.amount > 0
      ? current.quote.amount
      : Math.max(2000, Math.round((upPrice * 0.52) / 100) * 100);

  const naturalBonus =
    current.bonus ? (current.bonus.override?.amount ?? current.bonus.amount) : 0;

  // Calculate a market price and bonus such that market + premium + bonus < upPrice (leaving positive customerPays)
  let targetMarket = naturalMarket;
  let prem = premiumOn(targetMarket)?.amount ?? 0;
  let wePay = targetMarket + prem;

  // Reserve at least 15% (or ₹1,000) of the new phone price as customer payable if wePay >= upPrice
  const minPayable = Math.max(500, Math.min(2500, Math.round(upPrice * 0.12)));
  if (wePay > upPrice - minPayable) {
    targetMarket = Math.max(1000, Math.round(((upPrice - minPayable) * 0.85) / 100) * 100);
    prem = premiumOn(targetMarket)?.amount ?? 0;
    wePay = targetMarket + prem;
  }

  const maxAllowedBonus = Math.max(0, upPrice - wePay - minPayable);
  const targetBonus = Math.min(naturalBonus, maxAllowedBonus);

  const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const nextQuote = {
    ...(rawQuote ?? {}),
    status: "priced",
    amount: targetMarket,
    grade: (rawQuote?.grade as string) || "Good",
    validUntil: (rawQuote?.validUntil as string) || validUntil,
    quotedAt: (rawQuote?.quotedAt as string) || nowIso(),
    partnerRef: (rawQuote?.partnerRef as string) || `PIQ-${id.slice(-6).toUpperCase()}`,
    adjustedForUpgrade: targetMarket !== naturalMarket || targetBonus !== naturalBonus,
    lines: [
      { label: "Market trade-in value", amount: targetMarket },
    ],
    source: (rawQuote?.source as Record<string, unknown>) || {
      kind: "priceiq",
      label: "PriceIQ · live market",
    },
  };

  let nextBonus = rawBonus;
  if (rawBonus && targetBonus !== naturalBonus) {
    nextBonus = {
      ...rawBonus,
      amount: targetBonus,
      clampedBy: "cap",
    };
  }

  const repairPays = current.repair?.status === "quoted" ? current.repair.customerPays : 5000;
  const nextDecision = decide({
    repairPays,
    repairCovered: false,
    repairedValue: Math.round(targetMarket * 1.15),
    asIsValue: wePay,
    premium: prem,
    valueSource: "priceiq",
    upgrade: {
      label: current.upgrade.label,
      newPrice: upPrice,
      bonus: targetBonus,
      supportEndYear: current.upgrade.supportEndYear,
    },
    old: {
      ageYears: current.device?.ageYears ?? 2,
      supportEndYear: current.device?.supportEndYear ?? 2027,
    },
    thisYear: new Date().getFullYear(),
    nothingToRepair: false,
    faultCount: current.faults.length,
    systemicFault: false,
    swollenBattery: false,
  });

  await execute(
    `UPDATE cases SET quote = $1, bonus = $2, decision = $3, status = 'quoted', updated_at = $4 WHERE id = $5`,
    [
      JSON.stringify(nextQuote),
      nextBonus ? JSON.stringify(nextBonus) : null,
      JSON.stringify(nextDecision),
      nowIso(),
      id,
    ]
  );

  return forViewer(u, await getCase(u, id));
}

/**
 * Strips all store balance, credit limit, and available wallet figures from a CaseView
 * when the viewer is a store counter login (`advisor`). Only `store_manager` (and higher admins)
 * may see store balance figures.
 */
export function redactCaseForCounter(u: SessionUser, view: CaseView): CaseView {
  if (u.role !== "advisor") return view;
  return {
    ...view,
    creditCheck: null,
    lockBlockers: view.lockBlockers.map((b) =>
      /credit limit|free\)/i.test(b) ? "Requires store manager approval to proceed." : b
    ),
  };
}

export async function getCaseForViewer(u: SessionUser, id: string): Promise<CaseView> {
  await syncIqEnvFromDb();
  let v = forViewer(u, await getCase(u, id));
  v = await ensureCounterCaseSwappable(u, id, v, false);
  return redactCaseForCounter(u, v);
}
