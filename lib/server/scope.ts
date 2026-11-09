import { query, queryOne, parseJson } from "./db";
import { HttpError, type SessionUser } from "./auth";

/**
 * Tenant scoping. Everything a caller can touch is derived from the SESSION.
 * Out-of-scope records are reported as 404 so a probe cannot learn they exist.
 */

export type OrgRow = {
  id: string;
  name: string;
  kind: "platform" | "client" | "partner";
  client_type: string | null;
  target_brand: string | null;
  partner_id: string | null;
  settings: string;
  demo: number;
  created_at: string;
};

export type StoreRow = {
  id: string;
  org_id: string;
  name: string;
  kind: "service_center" | "experience_center" | "retail";
  city: string | null;
  code: string;
  credit_limit: number;
  active: number;
  created_at: string;
  /** pending = registered itself, waiting for the programme to approve it and set a credit line. */
  status?: "pending" | "active" | "rejected";
  review_note?: string | null;
};

export async function getOrg(id: string): Promise<OrgRow | null> {
  return queryOne<OrgRow>("SELECT * FROM orgs WHERE id = $1", [id]);
}

export async function getStore(id: string): Promise<StoreRow | null> {
  return queryOne<StoreRow>("SELECT * FROM stores WHERE id = $1", [id]);
}

/** Client org ids a partner user serves. */
export async function partnerClientIds(partnerId: string): Promise<string[]> {
  const rows = await query<{ id: string }>("SELECT id FROM orgs WHERE kind = 'client' AND partner_id = $1", [partnerId]);
  return rows.map((r) => r.id);
}

/** Can this user see/act on this store at all? */
export async function canSeeStore(u: SessionUser, store: StoreRow): Promise<boolean> {
  switch (u.role) {
    case "platform":
      return true;
    case "org_admin":
      return store.org_id === u.orgId;
    case "store_manager":
    case "advisor":
      return store.id === u.storeId;
    case "partner":
      return (await partnerClientIds(u.orgId)).includes(store.org_id);
  }
}

export async function storeInScope(u: SessionUser, storeId: string): Promise<StoreRow> {
  const s = await getStore(storeId);
  if (!s || !(await canSeeStore(u, s))) throw new HttpError(404, "Store not found.");
  return s;
}

/** Stores the user may see, for lists. */
export async function storesForUser(u: SessionUser): Promise<StoreRow[]> {
  const all = await query<StoreRow>("SELECT * FROM stores ORDER BY name");
  const filtered: StoreRow[] = [];
  for (const s of all) {
    if (await canSeeStore(u, s)) filtered.push(s);
  }
  return filtered;
}

/** The one store a counter user works in. */
export async function ownStore(u: SessionUser): Promise<StoreRow> {
  if (!u.storeId) throw new HttpError(403, "This account is not attached to a store.");
  return storeInScope(u, u.storeId);
}

/** Orgs a user may administer (catalogues, campaigns, stores). */
export async function adminOrgId(u: SessionUser, requested?: string | null): Promise<string> {
  if (u.role === "platform") {
    if (!requested) throw new HttpError(400, "Choose a client.");
    const o = await getOrg(requested);
    if (!o || o.kind !== "client") throw new HttpError(404, "Client not found.");
    return o.id;
  }
  if (u.role === "org_admin") return u.orgId;
  throw new HttpError(403, "Your role cannot change programme settings.");
}

export async function orgPartnerId(orgId: string): Promise<string> {
  const o = await getOrg(orgId);
  if (!o?.partner_id) throw new HttpError(409, "This client has no buyback partner configured.");
  return o.partner_id;
}

export { parseJson };
