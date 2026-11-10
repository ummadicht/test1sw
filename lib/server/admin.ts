import { query, queryOne, execute, tx, nowIso, newId, parseJson, audit } from "./db";
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

async function orgView(o: OrgRow): Promise<OrgView> {
  const counts = await queryOne<{ s: string | number; u: string | number }>(
    `SELECT (SELECT COUNT(*) FROM stores WHERE org_id = $1) s, (SELECT COUNT(*) FROM users WHERE org_id = $2) u`,
    [o.id, o.id]
  );
  const partnerOrg = o.partner_id ? await getOrg(o.partner_id) : null;
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    clientType: o.client_type,
    targetBrand: o.target_brand,
    partnerId: o.partner_id,
    partnerName: partnerOrg?.name ?? null,
    settings: await orgSettings(o.id),
    demo: !!o.demo,
    stores: Number(counts?.s || 0),
    users: Number(counts?.u || 0),
  };
}

export async function listOrgs(u: SessionUser): Promise<OrgView[]> {
  if (u.role === "platform") {
    const rows = await query<OrgRow>(`SELECT * FROM orgs ORDER BY kind, name`);
    return Promise.all(rows.map(orgView));
  }
  const own = await getOrg(u.orgId);
  return own ? [await orgView(own)] : [];
}

const CLIENT_TYPES = ["oem_service", "retail_chain", "experience_center", "other"];

export async function createOrg(
  u: SessionUser,
  input: { name: string; kind: "client" | "partner"; clientType?: string; targetBrand?: string; partnerId?: string | null }
): Promise<OrgView> {
  if (u.role !== "platform") throw new HttpError(403, "Only SwapUp platform staff onboard clients and partners.");
  const name = String(input.name || "").trim();
  if (name.length < 3) throw new HttpError(400, "Name the organisation.");
  if (!["client", "partner"].includes(input.kind)) throw new HttpError(400, "Choose client or partner.");
  let partnerId: string | null = null;
  if (input.kind === "client") {
    if (!CLIENT_TYPES.includes(String(input.clientType))) throw new HttpError(400, "Choose the client type.");
    const p = input.partnerId ? await getOrg(input.partnerId) : null;
    if (!p || p.kind !== "partner") throw new HttpError(400, "Choose the buyback partner for this client.");
    partnerId = p.id;
  }
  const id = newId(input.kind === "client" ? "org" : "ptn");
  await execute(
    `INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, name, input.kind, input.kind === "client" ? input.clientType : null, input.kind === "client" ? (input.targetBrand || "Samsung").trim() : null, partnerId, JSON.stringify(orgSettingsDefaults()), nowIso()]
  );
  await audit({ userId: u.id, orgId: id, action: "org.create", entity: "org", entityId: id, detail: { name, kind: input.kind } });
  const fresh = await getOrg(id);
  return orgView(fresh!);
}

/** Programme settings: credit release point, pickup triggers, repair labour, thresholds, bonus band. */
export async function updateOrgSettings(u: SessionUser, orgIdReq: string | null, patch: Partial<OrgSettings>): Promise<OrgView> {
  const orgId = await adminOrgId(u, orgIdReq);
  const cur = await orgSettings(orgId);
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
  if (u.role !== "platform" && (patch.bandMinBp !== undefined || patch.bandMaxBp !== undefined)) errs.push("Only SwapUp platform staff can change the bonus band.");
  if (!(Number.isInteger(next.bandMinBp) && Number.isInteger(next.bandMaxBp) && next.bandMinBp >= 0 && next.bandMaxBp <= 1000 && next.bandMinBp <= next.bandMaxBp))
    errs.push("Bonus band must be whole basis points within 0–10%.");
  const t = next.thresholds;
  if (!(t.upgradeRatio > 0 && t.upgradeRatio <= 2 && t.repairRatio >= 0 && t.repairRatio < t.upgradeRatio)) errs.push("Repair/upgrade ratios look wrong.");
  if (next.quoteValidityDays !== null && (!Number.isInteger(next.quoteValidityDays) || next.quoteValidityDays < 1 || next.quoteValidityDays > 30))
    errs.push("Quote validity must be 1–30 days, or empty to use the partner's.");
  if (errs.length) throw new HttpError(400, errs[0]);

  await execute(`UPDATE orgs SET settings = $1 WHERE id = $2`, [JSON.stringify(next), orgId]);
  await audit({ userId: u.id, orgId, action: "org.settings", entity: "org", entityId: orgId, detail: { from: cur, to: next } });
  const fresh = await getOrg(orgId);
  return orgView(fresh!);
}

/* ── stores ───────────────────────────────────────────────── */

export async function listStores(u: SessionUser): Promise<(StoreRow & { org_name: string })[]> {
  const stores = await storesForUser(u);
  const orgMap = new Map<string, string>();
  const out: (StoreRow & { org_name: string })[] = [];
  for (const s of stores) {
    if (!orgMap.has(s.org_id)) {
      const o = await getOrg(s.org_id);
      orgMap.set(s.org_id, o?.name ?? "");
    }
    out.push({ ...s, org_name: orgMap.get(s.org_id) || "" });
  }
  return out;
}

export async function createStore(u: SessionUser, input: { orgId?: string; name: string; kind: string; city?: string; code: string; creditLimit: number }): Promise<StoreRow> {
  const orgId = await adminOrgId(u, input.orgId);
  const name = String(input.name || "").trim();
  const code = String(input.code || "").trim().toUpperCase();
  const limit = Number(input.creditLimit);
  if (name.length < 3) throw new HttpError(400, "Name the store.");
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new HttpError(400, "Store code: 2–8 letters or digits (it prefixes case numbers).");
  if (!["service_center", "experience_center", "retail"].includes(input.kind)) throw new HttpError(400, "Choose the store type.");
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw new HttpError(400, "Credit limit must be a whole rupee amount.");
  const taken = await queryOne(`SELECT 1 FROM stores WHERE code = $1`, [code]);
  if (taken) throw new HttpError(409, "Another store already uses that code.");
  const id = newId("st");
  try {
    await execute(
      `INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, orgId, name, input.kind, (input.city || "").trim() || null, code, limit, nowIso()]
    );
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes("unique") || msg.includes("23505") || msg.includes("UNIQUE")) throw new HttpError(409, "Another store already uses that code.");
    throw e;
  }
  await audit({ userId: u.id, orgId, storeId: id, action: "store.create", entity: "store", entityId: id, detail: { name, code, limit } });
  const fresh = await getStore(id);
  return fresh!;
}

/* ── users ────────────────────────────────────────────────── */

export type UserView = { id: string; username: string; name: string; role: Role; orgId: string; orgName: string; storeId: string | null; storeName: string | null; active: boolean; createdAt: string };

export async function listUsers(u: SessionUser): Promise<UserView[]> {
  const where =
    u.role === "platform" ? "" : u.role === "org_admin" || u.role === "partner" ? "WHERE u.org_id = $1" : u.role === "store_manager" ? "WHERE u.store_id = $1" : "WHERE 1=0";
  const args = u.role === "platform" ? [] : u.role === "store_manager" ? [u.storeId] : [u.orgId];
  const rows = await query<{
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
  }>(
    `SELECT u.*, o.name AS org_name, s.name AS store_name FROM users u JOIN orgs o ON o.id = u.org_id LEFT JOIN stores s ON s.id = u.store_id ${where} ORDER BY o.name, u.role, u.name`,
    args
  );
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

export async function createUser(
  u: SessionUser,
  input: { name: string; username: string; role: Role; orgId?: string | null; storeId?: string | null }
): Promise<{ user: UserView; tempPassword: string }> {
  const role = input.role;
  if (!mayCreate(u, role)) throw new HttpError(403, "You cannot create that kind of account.");
  const name = String(input.name || "").trim();
  const username = String(input.username || "").trim().toLowerCase();
  if (name.length < 2) throw new HttpError(400, "Enter the person's name.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, "Username: 3–32 lowercase letters, digits, dot, dash or underscore.");
  let orgId: string;
  let storeId: string | null = null;
  if (u.role === "platform") {
    const o = input.orgId ? await getOrg(input.orgId) : null;
    if (!o) throw new HttpError(400, "Choose the organisation.");
    const kindOk = role === "platform" ? o.kind === "platform" : role === "partner" ? o.kind === "partner" : o.kind === "client";
    if (!kindOk) throw new HttpError(400, "That role does not belong to that kind of organisation.");
    orgId = o.id;
  } else orgId = u.orgId;
  if (role === "store_manager" || role === "advisor") {
    const sid = u.role === "store_manager" ? u.storeId : input.storeId;
    const s = sid ? await getStore(sid) : null;
    if (!s || s.org_id !== orgId) throw new HttpError(400, "Choose the store this person works at.");
    storeId = s.id;
  }
  const temp = generateTempPassword();
  const id = newId("usr");
  try {
    await execute(
      `INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, orgId, storeId, username, name.slice(0, 80), role, hashPassword(temp), nowIso()]
    );
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes("unique") || msg.includes("23505")) throw new HttpError(409, "That username is taken.");
    throw e;
  }
  await audit({ userId: u.id, orgId, storeId, action: "user.create", entity: "user", entityId: id, detail: { username, role } });
  const all = await listUsers({ ...u, role: "platform" } as SessionUser);
  const user = all.find((x) => x.id === id)!;
  return { user, tempPassword: temp };
}

async function userInScope(u: SessionUser, id: string): Promise<{ id: string; org_id: string; store_id: string | null; role: Role }> {
  const t = await queryOne<{ id: string; org_id: string; store_id: string | null; role: Role }>(
    `SELECT id, org_id, store_id, role FROM users WHERE id = $1`,
    [id]
  );
  if (!t) throw new HttpError(404, "User not found.");
  const users = await listUsers(u);
  const visible = users.some((x) => x.id === id);
  if (!visible || !mayCreate(u, t.role)) throw new HttpError(404, "User not found.");
  return t;
}

export async function resetPassword(u: SessionUser, id: string): Promise<{ tempPassword: string }> {
  const t = await userInScope(u, id);
  const temp = generateTempPassword();
  await execute(`UPDATE users SET password_hash = $1, pin_hash = NULL, pin_set_at = NULL WHERE id = $2`, [hashPassword(temp), t.id]);
  await audit({ userId: u.id, orgId: t.org_id, action: "user.reset_password", entity: "user", entityId: id });
  return { tempPassword: temp };
}

export async function setUserActive(u: SessionUser, id: string, active: boolean): Promise<UserView[]> {
  if (id === u.id) throw new HttpError(400, "You cannot deactivate yourself.");
  const t = await userInScope(u, id);
  await tx(async () => {
    await execute(
      `UPDATE users SET active = $1${active ? "" : ", pin_hash = NULL, pin_set_at = NULL"} WHERE id = $2`,
      [active ? 1 : 0, t.id]
    );
    if (!active && t.role === "platform") {
      const left = await queryOne<{ n: string | number }>(`SELECT COUNT(*) n FROM users WHERE role = 'platform' AND active = 1`);
      if (Number(left?.n || 0) === 0) throw new HttpError(409, "That is the last platform account.");
    }
    await audit({ userId: u.id, orgId: t.org_id, action: active ? "user.activate" : "user.deactivate", entity: "user", entityId: id });
  });
  return listUsers(u);
}

export async function changeOwnPassword(u: SessionUser, current: string, next: string): Promise<void> {
  const row = await queryOne<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
  if (!row || !verifyPassword(current, row.password_hash)) throw new HttpError(400, "Current password is wrong.");
  if ((next || "").length < 10) throw new HttpError(400, "New password must be at least 10 characters.");
  await execute(`UPDATE users SET password_hash = $1, pin_hash = NULL, pin_set_at = NULL WHERE id = $2`, [hashPassword(next), u.id]);
  await audit({ userId: u.id, orgId: u.orgId, action: "user.change_password", entity: "user", entityId: u.id });
}

export { parseJson };
