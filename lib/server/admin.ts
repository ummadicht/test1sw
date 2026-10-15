import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, hashPassword, verifyPassword, generateTempPassword, orgSettings, orgSettingsDefaults, type Role, type SessionUser, type OrgSettings } from "./auth";
import { getOrg, getStore, storesForUser, adminOrgId, type OrgRow, type StoreRow } from "./scope";

/* ── orgs: clients and partners (platform only) ───────────── */

export type OrgView = {
  id: string;
  name: string;
  kind: OrgRow["kind"];
  clientType: string | null;
  targetBrand: string | null;
  partnerId: string | null;
  partnerName: string | null;
  settings: OrgSettings;
  demo: boolean;
  stores: number;
  users: number;
};

function orgView(o: OrgRow): OrgView {
  const counts = db().prepare(`SELECT (SELECT COUNT(*) FROM stores WHERE org_id = ?) s, (SELECT COUNT(*) FROM users WHERE org_id = ?) u`).get(o.id, o.id) as { s: number; u: number };
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    clientType: o.client_type,
    targetBrand: o.target_brand,
    partnerId: o.partner_id,
    partnerName: o.partner_id ? getOrg(o.partner_id)?.name ?? null : null,
    settings: orgSettings(o.id),
    demo: !!o.demo,
    stores: counts.s,
    users: counts.u,
  };
}

export function listOrgs(u: SessionUser): OrgView[] {
  if (u.role === "platform") return (db().prepare(`SELECT * FROM orgs ORDER BY kind, name`).all() as OrgRow[]).map(orgView);
  const own = getOrg(u.orgId);
  return own ? [orgView(own)] : [];
}

const CLIENT_TYPES = ["oem_service", "retail_chain", "experience_center", "other"];

export function createOrg(
  u: SessionUser,
  input: { name: string; kind: "client" | "partner"; clientType?: string; targetBrand?: string; partnerId?: string | null }
): OrgView {
  if (u.role !== "platform") throw new HttpError(403, "Only SwapUp platform staff onboard clients and partners.");
  const name = String(input.name || "").trim();
  if (name.length < 3) throw new HttpError(400, "Name the organisation.");
  if (!["client", "partner"].includes(input.kind)) throw new HttpError(400, "Choose client or partner.");
  let partnerId: string | null = null;
  if (input.kind === "client") {
    if (!CLIENT_TYPES.includes(String(input.clientType))) throw new HttpError(400, "Choose the client type.");
    const p = input.partnerId ? getOrg(input.partnerId) : null;
    if (!p || p.kind !== "partner") throw new HttpError(400, "Choose the buyback partner for this client.");
    partnerId = p.id;
  }
  const id = newId(input.kind === "client" ? "org" : "ptn");
  db()
    .prepare(`INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, input.kind, input.kind === "client" ? input.clientType : null, input.kind === "client" ? (input.targetBrand || "Samsung").trim() : null, partnerId, JSON.stringify(orgSettingsDefaults()), nowIso());
  audit({ userId: u.id, orgId: id, action: "org.create", entity: "org", entityId: id, detail: { name, kind: input.kind } });
  return orgView(getOrg(id)!);
}

/** Programme settings: credit release point, pickup triggers, repair labour, thresholds, bonus band. */
export function updateOrgSettings(u: SessionUser, orgIdReq: string | null, patch: Partial<OrgSettings>): OrgView {
  const orgId = adminOrgId(u, orgIdReq);
  const cur = orgSettings(orgId);
  const next: OrgSettings = {
    ...cur,
    ...patch,
    repairPolicy: {
      ...cur.repairPolicy,
      ...(patch.repairPolicy ?? {}),
      labourByTier: { ...cur.repairPolicy.labourByTier, ...(patch.repairPolicy?.labourByTier ?? {}) },
    },
    thresholds: { ...cur.thresholds, ...(patch.thresholds ?? {}) },
  };
  const errs: string[] = [];
  if (!["collected", "cleared"].includes(next.releaseOn)) errs.push("Release point must be collected or cleared.");
  if (!(next.warnAt > 0 && next.warnAt <= 1)) errs.push("Pickup warning must be between 1% and 100%.");
  if (!Number.isInteger(next.maxAgeDays) || next.maxAgeDays < 1 || next.maxAgeDays > 60) errs.push("Max days at store must be 1–60.");
  if (!Number.isInteger(next.pickupAtCount) || next.pickupAtCount < 1 || next.pickupAtCount > 500) errs.push("Pickup device count must be 1–500.");
  if (!["store", "partner"].includes(next.shortfallLiability)) errs.push("Shortfall liability must be store or partner.");
  for (const [k, v] of Object.entries(next.repairPolicy.labourByTier)) if (!Number.isInteger(v) || v < 0 || v > 50_000) errs.push(`Labour for tier ${k} must be a whole rupee amount.`);
  if (!Number.isInteger(next.repairPolicy.carePlusFeeDefault) || next.repairPolicy.carePlusFeeDefault < 0) errs.push("Plan fee must be a whole rupee amount.");
  if (!Number.isInteger(next.repairPolicy.gstBp) || next.repairPolicy.gstBp < 0 || next.repairPolicy.gstBp > 2800) errs.push("GST must be 0–28%.");
  // The 2–5% band is the PROGRAMME's promise; only platform staff may move it, and never outside 0–10%.
  if (u.role !== "platform" && (patch.bandMinBp !== undefined || patch.bandMaxBp !== undefined)) errs.push("Only SwapUp platform staff can change the bonus band.");
  if (!(Number.isInteger(next.bandMinBp) && Number.isInteger(next.bandMaxBp) && next.bandMinBp >= 0 && next.bandMaxBp <= 1000 && next.bandMinBp <= next.bandMaxBp))
    errs.push("Bonus band must be whole basis points within 0–10%.");
  const t = next.thresholds;
  if (!(t.upgradeRatio > 0 && t.upgradeRatio <= 2 && t.repairRatio >= 0 && t.repairRatio < t.upgradeRatio)) errs.push("Repair/upgrade ratios look wrong.");
  if (next.quoteValidityDays !== null && (!Number.isInteger(next.quoteValidityDays) || next.quoteValidityDays < 1 || next.quoteValidityDays > 30))
    errs.push("Quote validity must be 1–30 days, or empty to use the partner's.");
  if (errs.length) throw new HttpError(400, errs[0]);
  db().prepare(`UPDATE orgs SET settings = ? WHERE id = ?`).run(JSON.stringify(next), orgId);
  audit({ userId: u.id, orgId, action: "org.settings", entity: "org", entityId: orgId, detail: { from: cur, to: next } });
  return orgView(getOrg(orgId)!);
}

/* ── stores ───────────────────────────────────────────────── */

export function listStores(u: SessionUser): (StoreRow & { org_name: string })[] {
  return storesForUser(u).map((s) => ({ ...s, org_name: getOrg(s.org_id)?.name ?? "" }));
}

export function createStore(u: SessionUser, input: { orgId?: string; name: string; kind: string; city?: string; code: string; creditLimit: number }): StoreRow {
  const orgId = adminOrgId(u, input.orgId);
  const name = String(input.name || "").trim();
  const code = String(input.code || "").trim().toUpperCase();
  const limit = Number(input.creditLimit);
  if (name.length < 3) throw new HttpError(400, "Name the store.");
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new HttpError(400, "Store code: 2–8 letters or digits (it prefixes case numbers).");
  if (!["service_center", "experience_center", "retail"].includes(input.kind)) throw new HttpError(400, "Choose the store type.");
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw new HttpError(400, "Credit limit must be a whole rupee amount.");
  const id = newId("st");
  try {
    db()
      .prepare(`INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, orgId, name, input.kind, (input.city || "").trim() || null, code, limit, nowIso());
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) throw new HttpError(409, "Another store in this programme already uses that code.");
    throw e;
  }
  audit({ userId: u.id, orgId, storeId: id, action: "store.create", entity: "store", entityId: id, detail: { name, code, limit } });
  return getStore(id)!;
}

/* ── users ────────────────────────────────────────────────── */

export type UserView = { id: string; username: string; name: string; role: Role; orgId: string; orgName: string; storeId: string | null; storeName: string | null; active: boolean; createdAt: string };

export function listUsers(u: SessionUser): UserView[] {
  const where =
    u.role === "platform" ? "" : u.role === "org_admin" || u.role === "partner" ? "WHERE u.org_id = ?" : u.role === "store_manager" ? "WHERE u.store_id = ?" : "WHERE 0";
  const args = u.role === "platform" ? [] : u.role === "store_manager" ? [u.storeId] : [u.orgId];
  const rows = db()
    .prepare(
      `SELECT u.*, o.name AS org_name, s.name AS store_name FROM users u JOIN orgs o ON o.id = u.org_id LEFT JOIN stores s ON s.id = u.store_id ${where} ORDER BY o.name, u.role, u.name`
    )
    .all(...args) as {
    id: string;
    username: string;
    name: string;
    role: Role;
    org_id: string;
    org_name: string;
    store_id: string | null;
    store_name: string | null;
    active: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    orgId: r.org_id,
    orgName: r.org_name,
    storeId: r.store_id,
    storeName: r.store_name,
    active: !!r.active,
    createdAt: r.created_at,
  }));
}

/** Who may create whom. Nobody can create a role above their own. */
function mayCreate(u: SessionUser, role: Role): boolean {
  switch (u.role) {
    case "platform":
      return true;
    case "org_admin":
      return ["org_admin", "store_manager", "advisor"].includes(role);
    case "store_manager":
      return role === "advisor";
    case "partner":
      return role === "partner";
    default:
      return false;
  }
}

export function createUser(
  u: SessionUser,
  input: { name: string; username: string; role: Role; orgId?: string | null; storeId?: string | null }
): { user: UserView; tempPassword: string } {
  const role = input.role;
  if (!mayCreate(u, role)) throw new HttpError(403, "You cannot create that kind of account.");
  const name = String(input.name || "").trim();
  const username = String(input.username || "").trim().toLowerCase();
  if (name.length < 2) throw new HttpError(400, "Enter the person's name.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, "Username: 3–32 lowercase letters, digits, dot, dash or underscore.");
  let orgId: string;
  let storeId: string | null = null;
  if (u.role === "platform") {
    const o = input.orgId ? getOrg(input.orgId) : null;
    if (!o) throw new HttpError(400, "Choose the organisation.");
    const kindOk = role === "platform" ? o.kind === "platform" : role === "partner" ? o.kind === "partner" : o.kind === "client";
    if (!kindOk) throw new HttpError(400, "That role does not belong to that kind of organisation.");
    orgId = o.id;
  } else orgId = u.orgId;
  if (role === "store_manager" || role === "advisor") {
    const sid = u.role === "store_manager" ? u.storeId : input.storeId;
    const s = sid ? getStore(sid) : null;
    if (!s || s.org_id !== orgId) throw new HttpError(400, "Choose the store this person works at.");
    storeId = s.id;
  }
  const temp = generateTempPassword();
  const id = newId("usr");
  try {
    db()
      .prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, orgId, storeId, username, name.slice(0, 80), role, hashPassword(temp), nowIso());
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) throw new HttpError(409, "That username is taken.");
    throw e;
  }
  audit({ userId: u.id, orgId, storeId, action: "user.create", entity: "user", entityId: id, detail: { username, role } });
  const user = listUsers({ ...u, role: "platform" } as SessionUser).find((x) => x.id === id)!;
  return { user, tempPassword: temp };
}

function userInScope(u: SessionUser, id: string): { id: string; org_id: string; store_id: string | null; role: Role } {
  const t = db().prepare(`SELECT id, org_id, store_id, role FROM users WHERE id = ?`).get(id) as
    | { id: string; org_id: string; store_id: string | null; role: Role }
    | undefined;
  if (!t) throw new HttpError(404, "User not found.");
  const visible = listUsers(u).some((x) => x.id === id);
  if (!visible || !mayCreate(u, t.role)) throw new HttpError(404, "User not found.");
  return t;
}

export function resetPassword(u: SessionUser, id: string): { tempPassword: string } {
  const t = userInScope(u, id);
  const temp = generateTempPassword();
  db().prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(temp), t.id);
  audit({ userId: u.id, orgId: t.org_id, action: "user.reset_password", entity: "user", entityId: id });
  return { tempPassword: temp };
}

export function setUserActive(u: SessionUser, id: string, active: boolean): UserView[] {
  if (id === u.id) throw new HttpError(400, "You cannot deactivate yourself.");
  const t = userInScope(u, id);
  tx(() => {
    db().prepare(`UPDATE users SET active = ? WHERE id = ?`).run(active ? 1 : 0, t.id);
    if (!active && t.role === "platform") {
      const left = db().prepare(`SELECT COUNT(*) n FROM users WHERE role = 'platform' AND active = 1`).get() as { n: number };
      if (left.n === 0) throw new HttpError(409, "That is the last platform account.");
    }
    audit({ userId: u.id, orgId: t.org_id, action: active ? "user.activate" : "user.deactivate", entity: "user", entityId: id });
  });
  return listUsers(u);
}

export function changeOwnPassword(u: SessionUser, current: string, next: string): void {
  const row = db().prepare(`SELECT password_hash FROM users WHERE id = ?`).get(u.id) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) throw new HttpError(400, "Current password is wrong.");
  if ((next || "").length < 10) throw new HttpError(400, "New password must be at least 10 characters.");
  db().prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(next), u.id);
  audit({ userId: u.id, orgId: u.orgId, action: "user.change_password", entity: "user", entityId: u.id });
}

export { parseJson };
