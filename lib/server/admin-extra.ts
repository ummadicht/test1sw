import { db, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { adminOrgId, storesForUser } from "./scope";
import { listOrgs } from "./admin";
import type { SourceRef } from "../domain/repair";

/**
 * Small, additive reads/writes the programme admin console needs and the core
 * services do not expose. Nothing here changes an existing service's behaviour.
 */

/** Client organisations a platform user can pick from (org_admins get their own only). */
export function clientOrgs(u: SessionUser): { id: string; name: string; demo: boolean }[] {
  return listOrgs(u)
    .filter((o) => o.kind === "client")
    .map((o) => ({ id: o.id, name: o.name, demo: o.demo }));
}

export type TradeModelAdminView = {
  id: string;
  brand: string;
  model: string;
  series: string | null;
  releaseYear: number | null;
  supportEndYear: number | null;
  variants: string[];
  serviceTier: string;
  carePlusFee: number | null;
  source: SourceRef | null;
};

/** The global trade-in model list WITH the service tier and plan fee (which `tradeModels()` leaves out). */
export function tradeModelsDetailed(): TradeModelAdminView[] {
  const rows = db()
    .prepare(`SELECT * FROM trade_models ORDER BY brand = 'Samsung' DESC, brand, release_year DESC, model`)
    .all() as {
    id: string;
    brand: string;
    model: string;
    series: string | null;
    release_year: number | null;
    support_end_year: number | null;
    variants: string;
    service_tier: string;
    care_plus_fee: number | null;
    source: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    series: r.series,
    releaseYear: r.release_year,
    supportEndYear: r.support_end_year,
    variants: parseJson<string[]>(r.variants, []),
    serviceTier: r.service_tier,
    carePlusFee: r.care_plus_fee,
    source: parseJson<SourceRef | null>(r.source, null),
  }));
}

/**
 * Show or hide a new phone at the counter WITHOUT touching its price or price
 * source. (`saveNewDevice` rewrites the source to "entered by programme admin",
 * which is right for a price edit but would erase a published-price link on a
 * simple show/hide.)
 */
export function setNewDeviceActive(u: SessionUser, input: { orgId?: string | null; id: string; active: boolean }): void {
  const orgId = adminOrgId(u, input.orgId);
  const upd = db().prepare(`UPDATE new_devices SET active = ? WHERE id = ? AND org_id = ?`).run(input.active ? 1 : 0, String(input.id || ""), orgId);
  if (upd.changes !== 1) throw new HttpError(404, "Device not found.");
  audit({ userId: u.id, orgId, action: input.active ? "catalog.new_device.show" : "catalog.new_device.hide", entity: "new_device", entityId: input.id });
}

/** Case ids for case refs, limited to the stores this user can see (for linking report rows to cases). */
export function caseIdsByRef(u: SessionUser, refs: string[]): Record<string, string> {
  const uniq = [...new Set(refs.filter(Boolean))];
  const stores = storesForUser(u).map((s) => s.id);
  if (!uniq.length || !stores.length) return {};
  const out: Record<string, string> = {};
  // Chunk to stay well inside SQLite's bound-parameter limit.
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = db()
      .prepare(`SELECT id, ref FROM cases WHERE ref IN (${chunk.map(() => "?").join(",")}) AND store_id IN (${stores.map(() => "?").join(",")})`)
      .all(...chunk, ...stores) as { id: string; ref: string }[];
    for (const r of rows) out[r.ref] = r.id;
  }
  return out;
}
