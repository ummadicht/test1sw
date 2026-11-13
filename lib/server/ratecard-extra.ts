import { HttpError, type SessionUser } from "./auth";
import { getOrg } from "./scope";
import { tradeModels } from "./catalog";
import { activeRateCard } from "./buyback";
import { db, parseJson } from "./db";
import { RATE_CARD_COLUMNS, type RateCard, type RateEntry } from "../domain/ratecard";
import { SCREEN_ORDER, BODY_ORDER, SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL, type IssueId, type AgeBand } from "../domain/condition";

/**
 * Small additions for the partner rate-card screens. Nothing here prices a
 * phone; it only decides WHOSE cards a caller manages and builds the blank
 * sheet a partner fills in.
 */

/** A partner manages its own cards; platform staff name the partner (?partnerId=). Everyone else: no. */
export async function ratecardPartnerId(u: SessionUser, requested?: string | null): Promise<string> {
  if (u.role === "partner") return u.orgId;
  if (u.role === "platform") {
    if (!requested) throw new HttpError(400, "Choose a buyback partner.");
    const o = await getOrg(requested);
    if (!o || o.kind !== "partner") throw new HttpError(404, "Partner not found.");
    return o.id;
  }
  throw new HttpError(403, "Only the buyback partner manages its rate card.");
}

/** "Samsung Galaxy S22" for each catalogue model id — so a card's entries read as phones, not ids. */
export async function tradeModelNames(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of await tradeModels()) out[m.id] = `${m.brand} ${m.model}`;
  return out;
}

/**
 * The upload template: one row per catalogue model × storage, in the exact
 * `model_id,variant,max_price,good_price,fair_price,best_value_price` shape the
 * upload reads (the grade columns optional).
 *
 * Prices are pre-filled from the partner's ACTIVE card (its own sheet), grade
 * prices included; with no card the template is blank — SwapUp never fills in a
 * price of its own.
 */
export function rateCardTemplateCsvSync(partnerId: string): { csv: string; filename: string; prefilled: number; rows: number } | null {
  if (process.env.DATABASE_URL || process.env.PGHOST) return null;
  try {
    const card = activeRateCard(partnerId);
    const usable = card && card.source.kind === "partner_ratecard" ? card : null;
    const entry = new Map<string, RateEntry>();
    if (usable) for (const e of usable.entries) entry.set(`${e.modelId}|${e.variant}`, e);
    const lines = [RATE_CARD_COLUMNS.join(",")];
    let prefilled = 0;
    const sqlite = db();
    const rows = sqlite.prepare("SELECT * FROM trade_models ORDER BY brand, model").all() as { id: string; variants: string }[];
    for (const r of rows) {
      const variants = parseJson<string[]>(r.variants, []);
      for (const v of variants) {
        const e = entry.get(`${r.id}|${v}`);
        if (e) prefilled += 1;
        const g = e?.gradePrices ?? {};
        lines.push([r.id, v, e?.maxPrice ?? "", g.Good ?? "", g.Fair ?? "", g["Best Value"] ?? ""].join(","));
      }
    }
    const org = sqlite.prepare("SELECT name FROM orgs WHERE id = ?").get(partnerId) as { name?: string } | undefined;
    const slug = (org?.name ?? "partner").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "partner";
    const day = new Date().toISOString().slice(0, 10);
    return { csv: lines.join("\r\n") + "\r\n", filename: `${slug}-rate-card-template-${day}.csv`, prefilled, rows: lines.length - 1 };
  } catch {
    return null;
  }
}

export function rateCardTemplateCsv(partnerId: string): Promise<{ csv: string; filename: string; prefilled: number; rows: number }> & { csv: string; filename: string; prefilled: number; rows: number } {
  const sync = rateCardTemplateCsvSync(partnerId);
  const p = (async () => {
    if (sync) return sync;
    const card = await activeRateCard(partnerId);
    const usable = card && card.source.kind === "partner_ratecard" ? card : null;
    const entry = new Map<string, RateEntry>();
    if (usable) for (const e of usable.entries) entry.set(`${e.modelId}|${e.variant}`, e);
    const lines = [RATE_CARD_COLUMNS.join(",")];
    let prefilled = 0;
    for (const m of await tradeModels()) {
      for (const v of m.variants) {
        const e = entry.get(`${m.id}|${v}`);
        if (e) prefilled += 1;
        const g = e?.gradePrices ?? {};
        lines.push([m.id, v, e?.maxPrice ?? "", g.Good ?? "", g.Fair ?? "", g["Best Value"] ?? ""].join(","));
      }
    }
    const org = await getOrg(partnerId);
    const slug = (org?.name ?? "partner").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "partner";
    const day = new Date().toISOString().slice(0, 10);
    return { csv: lines.join("\r\n") + "\r\n", filename: `${slug}-rate-card-template-${day}.csv`, prefilled, rows: lines.length - 1 };
  })();
  if (sync) {
    return Object.assign(p, sync);
  }
  return p as any;
}

/**
 * Condition deductions sent with an upload. The upload service copies the
 * active card's deductions when none are sent, but it does not check a
 * supplied set — so every key must be here, as whole basis points 0–100%.
 */
export function readDeductions(input: unknown): RateCard["deductions"] {
  const bad = (what: string): never => {
    throw new HttpError(400, `Deduction for ${what} must be a percentage from 0 to 100.`);
  };
  const bp = (v: unknown, what: string): number => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return bad(what);
    return n;
  };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const d = obj(input);
  const group = <K extends string>(v: unknown, keys: readonly K[], labels: Record<K, string>, prefix: string): Record<K, number> => {
    const o = obj(v);
    const out = {} as Record<K, number>;
    for (const k of keys) out[k] = bp(o[k], `${prefix} “${labels[k]}”`);
    return out;
  };
  return {
    deadBp: bp(d.deadBp, "a phone that does not switch on"),
    callsBp: bp(d.callsBp, "calls / network not working"),
    screen: group(d.screen, SCREEN_ORDER, SCREEN_LABEL, "screen"),
    body: group(d.body, BODY_ORDER, BODY_LABEL, "body"),
    issues: group(d.issues, Object.keys(ISSUE_LABEL) as IssueId[], ISSUE_LABEL, "issue"),
    noChargerBp: bp(d.noChargerBp, "no original charger"),
    noBoxBp: bp(d.noBoxBp, "no original box"),
    noBillBp: bp(d.noBillBp, "no purchase bill"),
    age: group(d.age, Object.keys(AGE_LABEL) as AgeBand[], AGE_LABEL, "age"),
  };
}
