import { db, parseJson } from "./db";
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

export function getOrg(id: string): OrgRow | null {
  return (db().prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) as OrgRow | undefined) ?? null;
}

export function getStore(id: string): StoreRow | null {
  return (db().prepare(`SELECT * FROM stores WHERE id = ?`).get(id) as StoreRow | undefined) ?? null;
}

/** Client org ids a partner user serves. */
export function partnerClientIds(partnerId: string): string[] {
  return (db().prepare(`SELECT id FROM orgs WHERE kind = 'client' AND partner_id = ?`).all(partnerId) as { id: string }[]).map((r) => r.id);
}

/** Can this user see/act on this store at all? */
export function canSeeStore(u: SessionUser, store: StoreRow): boolean {
  switch (u.role) {
    case "platform":
      return true;
    case "org_admin":
      return store.org_id === u.orgId;
    case "store_manager":
    case "advisor":
      return store.id === u.storeId;
    case "partner":
      return partnerClientIds(u.orgId).includes(store.org_id);
  }
}

export function storeInScope(u: SessionUser, storeId: string): StoreRow {
  const s = getStore(storeId);
  if (!s || !canSeeStore(u, s)) throw new HttpError(404, "Store not found.");
  return s;
}

/** Stores the user may see, for lists. */
export function storesForUser(u: SessionUser): StoreRow[] {
  const all = db().prepare(`SELECT * FROM stores ORDER BY name`).all() as StoreRow[];
  return all.filter((s) => canSeeStore(u, s));
}

/** The one store a counter user works in. */
export function ownStore(u: SessionUser): StoreRow {
  if (!u.storeId) throw new HttpError(403, "This account is not attached to a store.");
  return storeInScope(u, u.storeId);
}

/** Orgs a user may administer (catalogues, campaigns, stores). */
export function adminOrgId(u: SessionUser, requested?: string | null): string {
  if (u.role === "platform") {
    if (!requested) throw new HttpError(400, "Choose a client.");
    const o = getOrg(requested);
    if (!o || o.kind !== "client") throw new HttpError(404, "Client not found.");
    return o.id;
  }
  if (u.role === "org_admin") return u.orgId;
  throw new HttpError(403, "Your role cannot change programme settings.");
}

export function orgPartnerId(orgId: string): string {
  const o = getOrg(orgId);
  if (!o?.partner_id) throw new HttpError(409, "This client has no buyback partner configured.");
  return o.partner_id;
}

export { parseJson };
