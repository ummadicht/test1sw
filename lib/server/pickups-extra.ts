import { db } from "./db";

/**
 * Additive read helper for the credit / pickups / case-list pages.
 *
 * `CaseListItem` carries a trade-in figure but not where it came from, and the
 * honesty rule says a SAMPLE figure must be marked wherever it appears. This
 * returns the source of the quote each case was priced (and locked) at.
 *
 * Pass only ids that came out of an already role-scoped list (listCases,
 * listPickups, creditSummary, openChargebacks) — it does not re-check scope and
 * returns nothing but the source kind/label.
 */
export type TradeSource = { kind: string | null; label: string | null };

export function tradeSources(caseIds: string[]): Record<string, TradeSource> {
  const ids = [...new Set(caseIds.filter(Boolean))];
  const out: Record<string, TradeSource> = {};
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db()
      .prepare(
        `SELECT id, json_extract(quote,'$.source.kind') AS kind, json_extract(quote,'$.source.label') AS label
         FROM cases WHERE id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk) as { id: string; kind: string | null; label: string | null }[];
    for (const r of rows) out[r.id] = { kind: r.kind, label: r.label };
  }
  return out;
}
