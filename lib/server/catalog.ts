import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { adminOrgId, getOrg } from "./scope";
import { validateCampaign, type Campaign } from "../domain/bonus";
import type { RateCard, RateEntry } from "../domain/ratecard";
import { PART_LABEL, type PartId } from "../domain/condition";
import type { SourceRef } from "../domain/repair";

/* ── trade-in models (global) ─────────────────────────────── */

export type TradeModelView = {
  id: string;
  brand: string;
  model: string;
  series: string | null;
  releaseYear: number | null;
  supportEndYear: number | null;
  variants: string[];
  source: SourceRef | null;
};

type TMRow = { id: string; brand: string; model: string; series: string | null; release_year: number | null; support_end_year: number | null; variants: string; source: string };

function tmView(r: TMRow): TradeModelView {
  return {
    id: r.id,
    brand: r.brand,
    model: r.model,
    series: r.series,
    releaseYear: r.release_year,
    supportEndYear: r.support_end_year,
    variants: parseJson<string[]>(r.variants, []),
    source: parseJson<SourceRef | null>(r.source, null),
  };
}

export function tradeModels(q?: string | null, brand?: string | null): TradeModelView[] {
  const where: string[] = [];
  const args: string[] = [];
  if (brand) {
    where.push("brand = ?");
    args.push(brand);
  }
  if (q) {
    where.push("(brand || ' ' || model) LIKE ?");
    args.push(`%${q.trim()}%`);
  }
  const rows = db()
    .prepare(`SELECT * FROM trade_models ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY brand = 'Samsung' DESC, brand, release_year DESC, model`)
    .all(...args) as TMRow[];
  return rows.map(tmView);
}

export function tradeBrands(): string[] {
  return (db().prepare(`SELECT DISTINCT brand FROM trade_models ORDER BY brand = 'Samsung' DESC, brand`).all() as { brand: string }[]).map((r) => r.brand);
}

/* ── new devices (per client org) ─────────────────────────── */

export type NewDeviceView = {
  id: string;
  brand: string;
  model: string;
  series: string;
  variant: string;
  price: number;
  supportEndYear: number | null;
  active: boolean;
  source: SourceRef | null;
};

type NDRow = { id: string; org_id: string; brand: string; model: string; series: string; variant: string; price: number; support_end_year: number | null; active: number; sort: number; source: string };

export function newDevices(orgId: string, includeInactive = false): NewDeviceView[] {
  const rows = db()
    .prepare(`SELECT * FROM new_devices WHERE org_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY sort, series, price DESC`)
    .all(orgId) as NDRow[];
  return rows.map((r) => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    series: r.series,
    variant: r.variant,
    price: r.price,
    supportEndYear: r.support_end_year,
    active: !!r.active,
    source: parseJson<SourceRef | null>(r.source, null),
  }));
}

export function saveNewDevice(
  u: SessionUser,
  input: { orgId?: string; id?: string | null; brand?: string; model: string; series: string; variant: string; price: number; supportEndYear?: number | null; active?: boolean; sourceLabel?: string }
): NewDeviceView[] {
  const orgId = adminOrgId(u, input.orgId);
  const model = String(input.model || "").trim();
  const variant = String(input.variant || "").trim();
  const series = String(input.series || "").trim().toUpperCase().slice(0, 2);
  const price = Number(input.price);
  if (model.length < 2 || variant.length < 2 || !series) throw new HttpError(400, "Model, series and variant are required.");
  if (!Number.isInteger(price) || price <= 0 || price > 1_000_000) throw new HttpError(400, "Price must be a whole rupee amount.");
  const sey = input.supportEndYear == null ? null : Number(input.supportEndYear);
  if (sey !== null && (!Number.isInteger(sey) || sey < 2020 || sey > 2045)) throw new HttpError(400, "Support end year looks wrong.");
  const source = JSON.stringify({ kind: "client", label: (input.sourceLabel || "Entered by programme admin").slice(0, 120), observedAt: nowIso().slice(0, 10) } satisfies SourceRef);
  tx(() => {
    if (input.id) {
      const upd = db()
        .prepare(`UPDATE new_devices SET brand = ?, model = ?, series = ?, variant = ?, price = ?, support_end_year = ?, active = ?, source = ? WHERE id = ? AND org_id = ?`)
        .run(input.brand || "Samsung", model, series, variant, price, sey, input.active === false ? 0 : 1, source, input.id, orgId);
      if (upd.changes !== 1) throw new HttpError(404, "Device not found.");
    } else {
      db()
        .prepare(`INSERT INTO new_devices (id, org_id, brand, model, series, variant, price, support_end_year, active, sort, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(newId("nd"), orgId, input.brand || "Samsung", model, series, variant, price, sey, input.active === false ? 0 : 1, 100, source);
    }
    audit({ userId: u.id, orgId, action: "catalog.new_device.save", entity: "new_device", entityId: input.id ?? undefined, detail: { model, variant, price } });
  });
  return newDevices(orgId, true);
}

/* ── repair price book (per client org) ───────────────────── */

export type RepairPriceView = { modelId: string; brand: string; model: string; part: PartId; partLabel: string; price: number; source: SourceRef | null };

export function repairBook(orgId: string, modelId?: string | null): RepairPriceView[] {
  const rows = db()
    .prepare(
      `SELECT r.*, t.brand, t.model FROM repair_book r LEFT JOIN trade_models t ON t.id = r.model_id
       WHERE r.org_id = ? ${modelId ? "AND r.model_id = ?" : ""} ORDER BY t.brand, t.model, r.part`
    )
    .all(...(modelId ? [orgId, modelId] : [orgId])) as { model_id: string; part: PartId; price: number; source: string; brand: string; model: string }[];
  return rows.map((r) => ({
    modelId: r.model_id,
    brand: r.brand,
    model: r.model,
    part: r.part,
    partLabel: PART_LABEL[r.part] ?? r.part,
    price: r.price,
    source: parseJson<SourceRef | null>(r.source, null),
  }));
}

export function saveRepairPrice(u: SessionUser, input: { orgId?: string; modelId: string; part: string; price: number | null; sourceLabel?: string }): RepairPriceView[] {
  const orgId = adminOrgId(u, input.orgId);
  if (!(input.part in PART_LABEL)) throw new HttpError(400, "Unknown part.");
  const tm = db().prepare(`SELECT id FROM trade_models WHERE id = ?`).get(input.modelId);
  if (!tm) throw new HttpError(400, "Unknown model.");
  tx(() => {
    if (input.price === null) {
      db().prepare(`DELETE FROM repair_book WHERE org_id = ? AND model_id = ? AND part = ?`).run(orgId, input.modelId, input.part);
    } else {
      const price = Number(input.price);
      if (!Number.isInteger(price) || price < 0 || price > 500_000) throw new HttpError(400, "Price must be a whole rupee amount.");
      const source = JSON.stringify({ kind: "client", label: (input.sourceLabel || "Entered by programme admin").slice(0, 120), observedAt: nowIso().slice(0, 10) } satisfies SourceRef);
      db()
        .prepare(`INSERT INTO repair_book (org_id, model_id, part, price, source) VALUES (?,?,?,?,?) ON CONFLICT(org_id, model_id, part) DO UPDATE SET price = excluded.price, source = excluded.source`)
        .run(orgId, input.modelId, input.part, price, source);
    }
    audit({ userId: u.id, orgId, action: "catalog.repair_price.save", entity: "repair_book", entityId: `${input.modelId}:${input.part}`, detail: { price: input.price } });
  });
  return repairBook(orgId, input.modelId);
}

/* ── campaigns (per client org) ───────────────────────────── */

export function campaigns(orgId: string): (Campaign & { active: boolean })[] {
  return (db().prepare(`SELECT id, data, active FROM campaigns WHERE org_id = ? ORDER BY created_at DESC`).all(orgId) as { id: string; data: string; active: number }[]).map(
    (r) => ({ ...parseJson<Campaign>(r.data, {} as Campaign), id: r.id, active: !!r.active })
  );
}

export function activeCampaigns(orgId: string): Campaign[] {
  return campaigns(orgId).filter((c) => c.active);
}

export function saveCampaign(u: SessionUser, input: { orgId?: string; campaign: Campaign; active?: boolean }): (Campaign & { active: boolean })[] {
  const orgId = adminOrgId(u, input.orgId);
  const s = orgSettings(orgId);
  const c = input.campaign;
  const errs = validateCampaign(c, { minBp: s.bandMinBp, maxBp: s.bandMaxBp });
  if (!c.name || c.name.trim().length < 3) errs.unshift("Give the campaign a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.startsOn || "")) errs.push("Start date must be YYYY-MM-DD.");
  if (c.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(c.endsOn)) errs.push("End date must be YYYY-MM-DD.");
  if (!["new_price", "trade_in_value"].includes(c.basis)) errs.push("Unknown bonus basis.");
  if (!Array.isArray(c.rules) || c.rules.length === 0) errs.push("A campaign needs at least one rule.");
  if (errs.length) throw new HttpError(400, errs[0]);
  const id = c.id && c.id.startsWith("cmp_") ? c.id : newId("cmp");
  const data = JSON.stringify({ ...c, id, name: c.name.trim() });
  tx(() => {
    const exists = db().prepare(`SELECT 1 FROM campaigns WHERE id = ? AND org_id = ?`).get(id, orgId);
    if (exists) db().prepare(`UPDATE campaigns SET data = ?, active = ? WHERE id = ? AND org_id = ?`).run(data, input.active === false ? 0 : 1, id, orgId);
    else db().prepare(`INSERT INTO campaigns (id, org_id, data, active, created_at) VALUES (?,?,?,?,?)`).run(id, orgId, data, input.active === false ? 0 : 1, nowIso());
    audit({ userId: u.id, orgId, action: "campaign.save", entity: "campaign", entityId: id, detail: { name: c.name, minBp: c.minBp, maxBp: c.maxBp } });
  });
  return campaigns(orgId);
}

/* ── partner rate cards ───────────────────────────────────── */

export type RateCardSummary = { id: string; label: string; kind: string; effectiveFrom: string; entries: number; active: boolean; createdAt: string; quoteValidityDays: number };

export function rateCards(partnerId: string): RateCardSummary[] {
  return (db().prepare(`SELECT id, data, active, created_at FROM rate_cards WHERE partner_id = ? ORDER BY created_at DESC`).all(partnerId) as {
    id: string;
    data: string;
    active: number;
    created_at: string;
  }[]).map((r) => {
    const d = parseJson<RateCard>(r.data, {} as RateCard);
    return {
      id: r.id,
      label: d.source?.label ?? "",
      kind: d.source?.kind ?? "",
      effectiveFrom: d.source?.effectiveFrom ?? "",
      entries: d.entries?.length ?? 0,
      active: !!r.active,
      createdAt: r.created_at,
      quoteValidityDays: d.quoteValidityDays,
    };
  });
}

export function rateCardDetail(partnerId: string, id: string): RateCard {
  const r = db().prepare(`SELECT id, data FROM rate_cards WHERE id = ? AND partner_id = ?`).get(id, partnerId) as { id: string; data: string } | undefined;
  if (!r) throw new HttpError(404, "Rate card not found.");
  return { ...parseJson<RateCard>(r.data, {} as RateCard), id: r.id };
}

function partnerIdFor(u: SessionUser, requested?: string | null): string {
  if (u.role === "partner") return u.orgId;
  if (u.role === "platform" && requested) {
    const o = getOrg(requested);
    if (o?.kind === "partner") return o.id;
  }
  throw new HttpError(403, "Only the buyback partner manages its rate card.");
}

/**
 * Upload a new rate card. Entries come as CSV `model_id,variant,max_price`
 * (header optional). Deduction rules are copied from the current active card
 * unless supplied. A model_id the catalogue does not know is REJECTED — a typo
 * would silently leave that phone unpriced.
 */
export function uploadRateCard(
  u: SessionUser,
  input: { partnerId?: string; label: string; effectiveFrom: string; quoteValidityDays: number; csv: string; deductions?: RateCard["deductions"]; activate?: boolean }
): RateCardSummary[] {
  const partnerId = partnerIdFor(u, input.partnerId);
  const label = String(input.label || "").trim();
  if (label.length < 3) throw new HttpError(400, "Name the rate card (e.g. sheet name and week).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom || "")) throw new HttpError(400, "Effective date must be YYYY-MM-DD.");
  const validity = Number(input.quoteValidityDays);
  if (!Number.isInteger(validity) || validity < 1 || validity > 30) throw new HttpError(400, "Quote validity must be 1–30 days.");
  const known = new Map((db().prepare(`SELECT id, variants FROM trade_models`).all() as { id: string; variants: string }[]).map((r) => [r.id, parseJson<string[]>(r.variants, [])]));
  const entries: RateEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  String(input.csv || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const [modelId, variant, priceRaw] = line.split(",").map((x) => (x ?? "").trim());
      if (i === 0 && /model/i.test(modelId)) return; // header
      const price = Number(String(priceRaw).replace(/[₹\s]/g, ""));
      if (!known.has(modelId)) return void errors.push(`Line ${i + 1}: unknown model id "${modelId}".`);
      if (!known.get(modelId)!.includes(variant)) return void errors.push(`Line ${i + 1}: "${variant}" is not a variant of ${modelId}.`);
      if (!Number.isInteger(price) || price <= 0) return void errors.push(`Line ${i + 1}: price must be a whole rupee amount.`);
      const key = `${modelId}|${variant}`;
      if (seen.has(key)) return void errors.push(`Line ${i + 1}: ${modelId} ${variant} appears twice.`);
      seen.add(key);
      entries.push({ modelId, variant, maxPrice: price });
    });
  if (errors.length) throw new HttpError(400, `${errors.length} problem${errors.length > 1 ? "s" : ""} in the sheet — ${errors.slice(0, 3).join(" ")}`);
  if (!entries.length) throw new HttpError(400, "The sheet has no prices.");
  const current = db().prepare(`SELECT data FROM rate_cards WHERE partner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`).get(partnerId) as { data: string } | undefined;
  const base = current ? parseJson<RateCard>(current.data, {} as RateCard) : null;
  // Only the partner's own card's deductions carry over: the new card is labelled a partner rate card.
  const inherited = base?.source?.kind === "partner_ratecard" ? base.deductions : undefined;
  const deductions = input.deductions ?? inherited;
  if (!deductions) throw new HttpError(400, "No deduction rules — supply them with the first rate card.");
  const id = newId("rc");
  const partnerName = getOrg(partnerId)?.name ?? "Partner";
  const card: RateCard = {
    id,
    partner: partnerName,
    source: { kind: "partner_ratecard", label, effectiveFrom: input.effectiveFrom },
    quoteValidityDays: validity,
    roundTo: base?.roundTo ?? 10,
    maxDeductionBp: base?.maxDeductionBp ?? 8500,
    floorBp: base?.floorBp ?? 500,
    deductions,
    entries,
  };
  tx(() => {
    if (input.activate !== false) db().prepare(`UPDATE rate_cards SET active = 0 WHERE partner_id = ?`).run(partnerId);
    db()
      .prepare(`INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, partnerId, JSON.stringify(card), input.activate === false ? 0 : 1, u.id, nowIso());
    audit({ userId: u.id, orgId: partnerId, action: "ratecard.upload", entity: "rate_card", entityId: id, detail: { label, entries: entries.length } });
  });
  return rateCards(partnerId);
}

export function activateRateCard(u: SessionUser, id: string, partnerIdReq?: string | null): RateCardSummary[] {
  const partnerId = partnerIdFor(u, partnerIdReq);
  tx(() => {
    const r = db().prepare(`SELECT 1 FROM rate_cards WHERE id = ? AND partner_id = ?`).get(id, partnerId);
    if (!r) throw new HttpError(404, "Rate card not found.");
    db().prepare(`UPDATE rate_cards SET active = 0 WHERE partner_id = ?`).run(partnerId);
    db().prepare(`UPDATE rate_cards SET active = 1 WHERE id = ?`).run(id);
    audit({ userId: u.id, orgId: partnerId, action: "ratecard.activate", entity: "rate_card", entityId: id });
  });
  return rateCards(partnerId);
}
