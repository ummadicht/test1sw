import { HttpError, type SessionUser } from "./auth";
import { getOrg } from "./scope";
import { tradeModels } from "./catalog";
import { activeRateCard } from "./buyback";
import type { RateCard } from "../domain/ratecard";
import { SCREEN_ORDER, BODY_ORDER, SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL, type IssueId, type AgeBand } from "../domain/condition";

/**
 * Small additions for the partner rate-card screens. Nothing here prices a
 * phone; it only decides WHOSE cards a caller manages and builds the blank
 * sheet a partner fills in.
 */

/** A partner manages its own cards; platform staff name the partner (?partnerId=). Everyone else: no. */
export function ratecardPartnerId(u: SessionUser, requested?: string | null): string {
  if (u.role === "partner") return u.orgId;
  if (u.role === "platform") {
    if (!requested) throw new HttpError(400, "Choose a buyback partner.");
    const o = getOrg(requested);
    if (!o || o.kind !== "partner") throw new HttpError(404, "Partner not found.");
    return o.id;
  }
  throw new HttpError(403, "Only the buyback partner manages its rate card.");
}

/** "Samsung Galaxy S22" for each catalogue model id — so a card's entries read as phones, not ids. */
export function tradeModelNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tradeModels()) out[m.id] = `${m.brand} ${m.model}`;
  return out;
}

/**
 * The upload template: one row per catalogue model × storage, in the exact
 * `model_id,variant,max_price` shape the upload reads.
 *
 * Prices are pre-filled from the partner's ACTIVE card only when that card is
 * the partner's own sheet. The built-in SAMPLE card's illustrative figures are
 * never copied into a template — uploaded back, they would come out labelled
 * "Partner rate card", and a made-up number would pass for the partner's price.
 */
export function rateCardTemplateCsv(partnerId: string): { csv: string; filename: string; prefilled: number; rows: number } {
  const card = activeRateCard(partnerId);
  const usable = card && card.source.kind === "partner_ratecard" ? card : null;
  const price = new Map<string, number>();
  if (usable) for (const e of usable.entries) price.set(`${e.modelId}|${e.variant}`, e.maxPrice);
  const lines = ["model_id,variant,max_price"];
  let prefilled = 0;
  for (const m of tradeModels()) {
    for (const v of m.variants) {
      const p = price.get(`${m.id}|${v}`);
      if (p !== undefined) prefilled += 1;
      lines.push(`${m.id},${v},${p ?? ""}`); // the upload splits on plain commas; ids and variants never contain one
    }
  }
  const slug = (getOrg(partnerId)?.name ?? "partner").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "partner";
  const day = new Date().toISOString().slice(0, 10);
  return { csv: lines.join("\r\n") + "\r\n", filename: `${slug}-rate-card-template-${day}.csv`, prefilled, rows: lines.length - 1 };
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
