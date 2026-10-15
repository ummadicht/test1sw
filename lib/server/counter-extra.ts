import { db } from "./db";
import type { SessionUser } from "./auth";
import { getCase, type CaseView } from "./cases";
import { getStore, canSeeStore } from "./scope";

/**
 * Where each listed case's trade-in figure came from (sample / rate card /
 * live / entered from the partner app). `CaseListItem` carries the amount but
 * not its source, and a SAMPLE figure must be labelled wherever it appears.
 * Additive helper for the counter screens; scoped like every other read.
 */
export function quoteSourceKinds(u: SessionUser, caseIds: string[]): Record<string, string | null> {
  const ids = [...new Set(caseIds)].slice(0, 500);
  if (!ids.length) return {};
  const rows = db()
    .prepare(`SELECT id, store_id, json_extract(quote, '$.source.kind') AS kind FROM cases WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; store_id: string; kind: string | null }[];
  const out: Record<string, string | null> = {};
  const seen = new Map<string, boolean>();
  for (const r of rows) {
    if (!seen.has(r.store_id)) {
      const s = getStore(r.store_id);
      seen.set(r.store_id, !!s && canSeeStore(u, s));
    }
    if (seen.get(r.store_id)) out[r.id] = r.kind;
  }
  return out;
}

/**
 * getCase for any viewer. The partner rule (a case still at the counter, or one
 * that never became a trade-in, is "not found" to the buyback partner) now lives
 * in cases.ts `caseInScope`, so every read path enforces it; this stays as the
 * name the counter pages import.
 */
export function getCaseForViewer(u: SessionUser, id: string): CaseView {
  return getCase(u, id);
}
