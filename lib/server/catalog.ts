import { query, queryOne, execute, tx, nowIso, newId, parseJson, audit, db } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { adminOrgId, getOrg } from "./scope";
import { validateCampaign, type Campaign } from "../domain/bonus";
import { gradePricesProblem, type GradePrices, type RateCard, type RateEntry } from "../domain/ratecard";
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

export async function tradeModels(q?: string | null, brand?: string | null): Promise<TradeModelView[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (brand) {
    args.push(brand);
    where.push(`brand = $${args.length}`);
  }
  if (q) {
    args.push(`%${q.trim()}%`);
    where.push(`(brand || ' ' || model) ILIKE $${args.length}`);
  }
  const rows = await query<TMRow>(
    `SELECT * FROM trade_models ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY brand = 'Samsung' DESC, brand, release_year DESC, model`,
    args
  );
  return rows.map(tmView);
}

export async function tradeBrands(): Promise<string[]> {
  const rows = await query<{ brand: string }>(
    `SELECT DISTINCT brand FROM trade_models ORDER BY brand = 'Samsung' DESC, brand`
  );
  return rows.map((r) => r.brand);
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

type NDRow = { id: string; org_id: string; brand: string; model: string; series: string; variant: string; price: number | string; support_end_year: number | null; active: number; sort: number; source: string };

export async function newDevices(orgId: string, includeInactive = false): Promise<NewDeviceView[]> {
  const rows = await query<NDRow>(
    `SELECT * FROM new_devices WHERE org_id = $1 ${includeInactive ? "" : "AND active = 1"} ORDER BY sort, series, price DESC`,
    [orgId]
  );
  return rows.map((r) => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    series: r.series,
    variant: r.variant,
    price: Number(r.price),
    supportEndYear: r.support_end_year,
    active: !!r.active,
    source: parseJson<SourceRef | null>(r.source, null),
  }));
}

export async function saveNewDevice(
  u: SessionUser,
  input: { orgId?: string; id?: string | null; brand?: string; model: string; series: string; variant: string; price: number; supportEndYear?: number | null; active?: boolean; sourceLabel?: string }
): Promise<NewDeviceView[]> {
  const orgId = await adminOrgId(u, input.orgId);
  const model = String(input.model || "").trim();
  const variant = String(input.variant || "").trim();
  const series = String(input.series || "").trim().toUpperCase().slice(0, 2);
  const price = Number(input.price);
  if (model.length < 2 || variant.length < 2 || !series) throw new HttpError(400, "Model, series and variant are required.");
  if (!Number.isInteger(price) || price <= 0 || price > 1_000_000) throw new HttpError(400, "Price must be a whole rupee amount.");
  const sey = input.supportEndYear == null ? null : Number(input.supportEndYear);
  if (sey !== null && (!Number.isInteger(sey) || sey < 2020 || sey > 2045)) throw new HttpError(400, "Support end year looks wrong.");
  const source = JSON.stringify({ kind: "client", label: (input.sourceLabel || "Entered by programme admin").slice(0, 120), observedAt: nowIso().slice(0, 10) } satisfies SourceRef);
  await tx(async () => {
    if (input.id) {
      const upd = await execute(
        `UPDATE new_devices SET brand = $1, model = $2, series = $3, variant = $4, price = $5, support_end_year = $6, active = $7, source = $8 WHERE id = $9 AND org_id = $10`,
        [input.brand || "Samsung", model, series, variant, price, sey, input.active === false ? 0 : 1, source, input.id, orgId]
      );
      if (upd.rowCount !== 1) throw new HttpError(404, "Device not found.");
    } else {
      await execute(
        `INSERT INTO new_devices (id, org_id, brand, model, series, variant, price, support_end_year, active, sort, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [newId("nd"), orgId, input.brand || "Samsung", model, series, variant, price, sey, input.active === false ? 0 : 1, 100, source]
      );
    }
    await audit({ userId: u.id, orgId, action: "catalog.new_device.save", entity: "new_device", entityId: input.id ?? undefined, detail: { model, variant, price } });
  });
  return newDevices(orgId, true);
}

/* ── repair price book (per client org) ───────────────────── */

export type RepairPriceView = { modelId: string; brand: string; model: string; part: PartId; partLabel: string; price: number; source: SourceRef | null };

export async function repairBook(orgId: string, modelId?: string | null): Promise<RepairPriceView[]> {
  const rows = await query<{ model_id: string; part: PartId; price: number | string; source: string; brand: string; model: string }>(
    `SELECT r.*, t.brand, t.model FROM repair_book r LEFT JOIN trade_models t ON t.id = r.model_id
     WHERE r.org_id = $1 ${modelId ? "AND r.model_id = $2" : ""} ORDER BY t.brand, t.model, r.part`,
    modelId ? [orgId, modelId] : [orgId]
  );
  return rows.map((r) => ({
    modelId: r.model_id,
    brand: r.brand,
    model: r.model,
    part: r.part,
    partLabel: PART_LABEL[r.part] ?? r.part,
    price: Number(r.price),
    source: parseJson<SourceRef | null>(r.source, null),
  }));
}

export async function saveRepairPrice(u: SessionUser, input: { orgId?: string; modelId: string; part: string; price: number | null; sourceLabel?: string }): Promise<RepairPriceView[]> {
  const orgId = await adminOrgId(u, input.orgId);
  if (!(input.part in PART_LABEL)) throw new HttpError(400, "Unknown part.");
  const tm = await queryOne("SELECT id FROM trade_models WHERE id = $1", [input.modelId]);
  if (!tm) throw new HttpError(400, "Unknown model.");
  await tx(async () => {
    if (input.price === null) {
      await execute("DELETE FROM repair_book WHERE org_id = $1 AND model_id = $2 AND part = $3", [orgId, input.modelId, input.part]);
    } else {
      const price = Number(input.price);
      if (!Number.isInteger(price) || price < 0 || price > 500_000) throw new HttpError(400, "Price must be a whole rupee amount.");
      const source = JSON.stringify({ kind: "client", label: (input.sourceLabel || "Entered by programme admin").slice(0, 120), observedAt: nowIso().slice(0, 10) } satisfies SourceRef);
      await execute(
        `INSERT INTO repair_book (org_id, model_id, part, price, source) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, model_id, part) DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source`,
        [orgId, input.modelId, input.part, price, source]
      );
    }
    await audit({ userId: u.id, orgId, action: "catalog.repair_price.save", entity: "repair_book", entityId: `${input.modelId}:${input.part}`, detail: { price: input.price } });
  });
  return repairBook(orgId, input.modelId);
}

/* ── campaigns (per client org) ───────────────────────────── */

export async function campaigns(orgId: string): Promise<(Campaign & { active: boolean })[]> {
  const rows = await query<{ id: string; data: string; active: number }>(
    `SELECT id, data, active FROM campaigns WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  return rows.map((r) => ({ ...parseJson<Campaign>(r.data, {} as Campaign), id: r.id, active: !!r.active }));
}

export async function activeCampaigns(orgId: string): Promise<Campaign[]> {
  const all = await campaigns(orgId);
  return all.filter((c) => c.active);
}

export async function saveCampaign(u: SessionUser, input: { orgId?: string; campaign: Campaign; active?: boolean }): Promise<(Campaign & { active: boolean })[]> {
  const orgId = await adminOrgId(u, input.orgId);
  const s = await orgSettings(orgId);
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
  await tx(async () => {
    const exists = await queryOne("SELECT 1 FROM campaigns WHERE id = $1 AND org_id = $2", [id, orgId]);
    if (exists) {
      await execute("UPDATE campaigns SET data = $1, active = $2 WHERE id = $3 AND org_id = $4", [data, input.active === false ? 0 : 1, id, orgId]);
    } else {
      await execute("INSERT INTO campaigns (id, org_id, data, active, created_at) VALUES ($1,$2,$3,$4,$5)", [id, orgId, data, input.active === false ? 0 : 1, nowIso()]);
    }
    await audit({ userId: u.id, orgId, action: "campaign.save", entity: "campaign", entityId: id, detail: { name: c.name, minBp: c.minBp, maxBp: c.maxBp } });
  });
  return campaigns(orgId);
}

/* ── partner rate cards ───────────────────────────────────── */

export type RateCardSummary = { id: string; label: string; kind: string; effectiveFrom: string; entries: number; active: boolean; createdAt: string; quoteValidityDays: number };

export async function rateCards(partnerId: string): Promise<RateCardSummary[]> {
  const rows = await query<{ id: string; data: string; active: number; created_at: string }>(
    `SELECT id, data, active, created_at FROM rate_cards WHERE partner_id = $1 ORDER BY created_at DESC`,
    [partnerId]
  );
  return rows.map((r) => {
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

export async function rateCardDetail(partnerId: string, id: string): Promise<RateCard> {
  const r = await queryOne<{ id: string; data: string }>(
    `SELECT id, data FROM rate_cards WHERE id = $1 AND partner_id = $2`,
    [id, partnerId]
  );
  if (!r) throw new HttpError(404, "Rate card not found.");
  return { ...parseJson<RateCard>(r.data, {} as RateCard), id: r.id };
}

async function partnerIdFor(u: SessionUser, requested?: string | null): Promise<string> {
  if (u.role === "partner") return u.orgId;
  if (u.role === "platform" && requested) {
    const o = await getOrg(requested);
    if (o?.kind === "partner") return o.id;
  }
  throw new HttpError(403, "Only the buyback partner manages its rate card.");
}

export function uploadRateCardSync(
  u: SessionUser,
  input: { partnerId?: string; label: string; effectiveFrom: string; quoteValidityDays: number; csv: string; deductions?: RateCard["deductions"]; activate?: boolean }
): void {
  if (process.env.DATABASE_URL || process.env.PGHOST) return;
  const partnerId = u.role === "partner" ? u.orgId : input.partnerId;
  if (!partnerId) throw new HttpError(400, "Choose a buyback partner.");
  const label = String(input.label || "").trim();
  if (label.length < 3) throw new HttpError(400, "Name the rate card (e.g. sheet name and week).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom || "")) throw new HttpError(400, "Effective date must be YYYY-MM-DD.");
  const validity = Number(input.quoteValidityDays);
  if (!Number.isInteger(validity) || validity < 1 || validity > 30) throw new HttpError(400, "Quote validity must be 1–30 days.");
  
  const sqlite = db();
  const tmRows = sqlite.prepare("SELECT id, variants FROM trade_models").all() as { id: string; variants: string }[];
  const known = new Map(tmRows.map((r) => [r.id, parseJson<string[]>(r.variants, [])]));
  
  const entries: RateEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  String(input.csv || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const [modelId, variant, priceRaw, ...gradeRaw] = line.split(",").map((x) => (x ?? "").trim());
      if (i === 0 && /model/i.test(modelId)) return;
      const price = Number(String(priceRaw).replace(/[₹\s]/g, ""));
      if (!known.has(modelId)) return void errors.push(`Line ${i + 1}: unknown model id "${modelId}".`);
      if (!known.get(modelId)!.includes(variant)) return void errors.push(`Line ${i + 1}: "${variant}" is not a variant of ${modelId}.`);
      if (!Number.isInteger(price) || price <= 0) return void errors.push(`Line ${i + 1}: price must be a whole rupee amount.`);
      const key = `${modelId}|${variant}`;
      if (seen.has(key)) return void errors.push(`Line ${i + 1}: ${modelId} ${variant} appears twice.`);
      const gradePrices: GradePrices = {};
      for (const [j, g] of (["Good", "Fair", "Best Value"] as const).entries()) {
        const raw = String(gradeRaw[j] ?? "").replace(/[₹\s]/g, "");
        if (raw !== "") gradePrices[g] = Number(raw);
      }
      const entry: RateEntry = { modelId, variant, maxPrice: price, ...(Object.keys(gradePrices).length ? { gradePrices } : {}) };
      const bad = gradePricesProblem(entry);
      if (bad) return void errors.push(`Line ${i + 1}: ${bad}.`);
      seen.add(key);
      entries.push(entry);
    });
  if (errors.length) throw new HttpError(400, `${errors.length} problem${errors.length > 1 ? "s" : ""} in the sheet — ${errors.slice(0, 3).join(" ")}`);
  if (!entries.length) throw new HttpError(400, "The sheet has no prices.");

  const current = sqlite.prepare(
    `SELECT data FROM rate_cards WHERE partner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`
  ).get(partnerId) as { data: string } | undefined;
  const base = current ? parseJson<RateCard>(current.data, {} as RateCard) : null;
  const inherited = base?.source?.kind === "partner_ratecard" ? base.deductions : undefined;
  const deductions = input.deductions ?? inherited;
  if (!deductions) throw new HttpError(400, "No deduction rules — supply them with the first rate card.");
  const id = newId("rc");
  const partnerOrg = sqlite.prepare(`SELECT name FROM orgs WHERE id = ?`).get(partnerId) as { name?: string } | undefined;
  const partnerName = partnerOrg?.name ?? "Partner";
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
  if (input.activate !== false) {
    sqlite.prepare("UPDATE rate_cards SET active = 0 WHERE partner_id = ?").run(partnerId);
  }
  sqlite.prepare(
    `INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES (?,?,?,?,?,?)`
  ).run(id, partnerId, JSON.stringify(card), input.activate === false ? 0 : 1, u.id, nowIso());
}

export function uploadRateCard(
  u: SessionUser,
  input: { partnerId?: string; label: string; effectiveFrom: string; quoteValidityDays: number; csv: string; deductions?: RateCard["deductions"]; activate?: boolean }
): Promise<RateCardSummary[]> {
  uploadRateCardSync(u, input);
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    const partnerId = u.role === "partner" ? u.orgId : input.partnerId!;
    return Promise.resolve(rateCards(partnerId));
  }
  return (async () => {
    const partnerId = await partnerIdFor(u, input.partnerId);
    const label = String(input.label || "").trim();
  if (label.length < 3) throw new HttpError(400, "Name the rate card (e.g. sheet name and week).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom || "")) throw new HttpError(400, "Effective date must be YYYY-MM-DD.");
  const validity = Number(input.quoteValidityDays);
  if (!Number.isInteger(validity) || validity < 1 || validity > 30) throw new HttpError(400, "Quote validity must be 1–30 days.");
  
  const tmRows = await query<{ id: string; variants: string }>("SELECT id, variants FROM trade_models");
  const known = new Map(tmRows.map((r) => [r.id, parseJson<string[]>(r.variants, [])]));
  
  const entries: RateEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  String(input.csv || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const [modelId, variant, priceRaw, ...gradeRaw] = line.split(",").map((x) => (x ?? "").trim());
      if (i === 0 && /model/i.test(modelId)) return;
      const price = Number(String(priceRaw).replace(/[₹\s]/g, ""));
      if (!known.has(modelId)) return void errors.push(`Line ${i + 1}: unknown model id "${modelId}".`);
      if (!known.get(modelId)!.includes(variant)) return void errors.push(`Line ${i + 1}: "${variant}" is not a variant of ${modelId}.`);
      if (!Number.isInteger(price) || price <= 0) return void errors.push(`Line ${i + 1}: price must be a whole rupee amount.`);
      const key = `${modelId}|${variant}`;
      if (seen.has(key)) return void errors.push(`Line ${i + 1}: ${modelId} ${variant} appears twice.`);
      const gradePrices: GradePrices = {};
      for (const [j, g] of (["Good", "Fair", "Best Value"] as const).entries()) {
        const raw = String(gradeRaw[j] ?? "").replace(/[₹\s]/g, "");
        if (raw !== "") gradePrices[g] = Number(raw);
      }
      const entry: RateEntry = { modelId, variant, maxPrice: price, ...(Object.keys(gradePrices).length ? { gradePrices } : {}) };
      const bad = gradePricesProblem(entry);
      if (bad) return void errors.push(`Line ${i + 1}: ${bad}.`);
      seen.add(key);
      entries.push(entry);
    });
  if (errors.length) throw new HttpError(400, `${errors.length} problem${errors.length > 1 ? "s" : ""} in the sheet — ${errors.slice(0, 3).join(" ")}`);
  if (!entries.length) throw new HttpError(400, "The sheet has no prices.");

  const current = await queryOne<{ data: string }>(
    `SELECT data FROM rate_cards WHERE partner_id = $1 AND active = 1 ORDER BY created_at DESC LIMIT 1`,
    [partnerId]
  );
  const base = current ? parseJson<RateCard>(current.data, {} as RateCard) : null;
  const inherited = base?.source?.kind === "partner_ratecard" ? base.deductions : undefined;
  const deductions = input.deductions ?? inherited;
  if (!deductions) throw new HttpError(400, "No deduction rules — supply them with the first rate card.");
  const id = newId("rc");
  const partnerOrg = await getOrg(partnerId);
  const partnerName = partnerOrg?.name ?? "Partner";
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
  await tx(async () => {
    if (input.activate !== false) {
      await execute("UPDATE rate_cards SET active = 0 WHERE partner_id = $1", [partnerId]);
    }
    await execute(
      `INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, partnerId, JSON.stringify(card), input.activate === false ? 0 : 1, u.id, nowIso()]
    );
    await audit({ userId: u.id, orgId: partnerId, action: "ratecard.upload", entity: "rate_card", entityId: id, detail: { label, entries: entries.length } });
  });
    return rateCards(partnerId);
  })();
}

export async function activateRateCard(u: SessionUser, id: string, partnerIdReq?: string | null): Promise<RateCardSummary[]> {
  const partnerId = await partnerIdFor(u, partnerIdReq);
  await tx(async () => {
    const r = await queryOne("SELECT 1 FROM rate_cards WHERE id = $1 AND partner_id = $2", [id, partnerId]);
    if (!r) throw new HttpError(404, "Rate card not found.");
    await execute("UPDATE rate_cards SET active = 0 WHERE partner_id = $1", [partnerId]);
    await execute("UPDATE rate_cards SET active = 1 WHERE id = $1", [id]);
    await audit({ userId: u.id, orgId: partnerId, action: "ratecard.activate", entity: "rate_card", entityId: id });
  });
  return rateCards(partnerId);
}
