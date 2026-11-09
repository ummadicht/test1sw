import { query, queryOne, execute, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { adminOrgId, storesForUser } from "./scope";
import { listOrgs } from "./admin";
import type { SourceRef } from "../domain/repair";

/**
 * Small, additive reads/writes the programme admin console needs and the core
 * services do not expose. Nothing here changes an existing service's behaviour.
 */

/** Client organisations a platform user can pick from (org_admins get their own only). */
export async function clientOrgs(u: SessionUser): Promise<{ id: string; name: string; demo: boolean }[]> {
  const orgs = await listOrgs(u);
  return orgs
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
export async function tradeModelsDetailed(): Promise<TradeModelAdminView[]> {
  const rows = await query<{
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
  }>(`SELECT * FROM trade_models ORDER BY brand = 'Samsung' DESC, brand, release_year DESC, model`);
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
 * source.
 */
export async function setNewDeviceActive(u: SessionUser, input: { orgId?: string | null; id: string; active: boolean }): Promise<void> {
  const orgId = await adminOrgId(u, input.orgId);
  const upd = await execute(
    `UPDATE new_devices SET active = $1 WHERE id = $2 AND org_id = $3`,
    [input.active ? 1 : 0, String(input.id || ""), orgId]
  );
  if (upd.rowCount !== 1) throw new HttpError(404, "Device not found.");
  await audit({ userId: u.id, orgId, action: input.active ? "catalog.new_device.show" : "catalog.new_device.hide", entity: "new_device", entityId: input.id });
}

/** Case ids for case refs, limited to the stores this user can see. */
export async function caseIdsByRef(u: SessionUser, refs: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(refs.filter(Boolean))];
  const userStores = await storesForUser(u);
  const stores = userStores.map((s) => s.id);
  if (!uniq.length || !stores.length) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = await query<{ id: string; ref: string }>(
      `SELECT id, ref FROM cases WHERE ref = ANY($1::text[]) AND store_id = ANY($2::text[])`,
      [chunk, stores]
    );
    for (const r of rows) out[r.ref] = r.id;
  }
  return out;
}
