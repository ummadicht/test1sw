import { createHash, randomInt } from "node:crypto";
import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, hashPassword, issueToken, orgSettings, type SessionUser, type Role } from "./auth";
import { getOrg, getStore, storeInScope, type StoreRow } from "./scope";
import { userPayload } from "./mobileAuth";

/**
 * SELF-SERVE SIGN-UP for the store app.
 *
 *   Register a store  A service centre / experience centre signs itself up into
 *                     a programme that allows it. It gets a store manager login
 *                     at once, but the store is PENDING: phone tests and quotes
 *                     work, taking a trade-in does not — every trade-in draws on a
 *                     credit line, and only the programme can grant one.
 *   Join a store      A manager issues an invite code (7 days, a few uses); staff
 *                     sign up with it as advisors at that store.
 *
 * Nothing here trusts the client for org/store/role: the programme must allow
 * self-registration, the invite decides the store and role.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const KINDS = ["service_center", "experience_center", "retail"] as const;

/* ── throttle: public endpoints ─────────────────────────────── */
const attempts = new Map<string, { n: number; until: number }>();
export function throttle(key: string, max = 10, windowMs = 30 * 60_000): void {
  const now = Date.now();
  const cur = attempts.get(key);
  if (cur && cur.until > now) {
    if (cur.n >= max) throw new HttpError(429, "Too many tries — wait a while.");
    cur.n += 1;
  } else attempts.set(key, { n: 1, until: now + windowMs });
}

/* ── validation shared by both paths ─────────────────────────── */
function cleanPerson(input: { name?: unknown; username?: unknown; password?: unknown; phone?: unknown }, needPhone: boolean) {
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  const username = String(input.username ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const phone = String(input.phone ?? "").replace(/\D/g, "");
  if (name.length < 2) throw new HttpError(400, "Enter your full name.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, "Username: 3–32 lowercase letters, numbers, dot, dash or underscore.");
  if (password.length < 8) throw new HttpError(400, "Choose a password of at least 8 characters.");
  if (/^(.)\1+$/.test(password) || password.toLowerCase() === username) throw new HttpError(400, "That password is too easy to guess.");
  if (needPhone && !/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, "Enter a 10-digit Indian mobile number.");
  const taken = db().prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
  if (taken) throw new HttpError(409, "That username is taken.");
  return { name: name.slice(0, 80), username, password, phone };
}

function tokenFor(userId: string) {
  const u = db().prepare(`SELECT id, org_id, store_id, username, name, role FROM users WHERE id = ?`).get(userId) as {
    id: string;
    org_id: string;
    store_id: string | null;
    username: string;
    name: string;
    role: Role;
  };
  const su: SessionUser = { id: u.id, orgId: u.org_id, storeId: u.store_id, username: u.username, name: u.name, role: u.role, exp: Date.now() + 12 * 3_600_000 };
  return { token: issueToken(su), expiresAt: new Date(su.exp).toISOString(), user: userPayload(su) };
}

/* ── programmes that accept self-registration ────────────────── */
export function selfSignupAllowed(orgId: string): boolean {
  const o = getOrg(orgId);
  if (!o || o.kind !== "client") return false;
  const s = orgSettings(orgId) as ReturnType<typeof orgSettings> & { selfSignup?: boolean };
  // Demo programmes accept it unless switched off; real ones only when switched on.
  return s.selfSignup ?? !!o.demo;
}

export function programmes() {
  const rows = db().prepare(`SELECT id, name, client_type, target_brand FROM orgs WHERE kind = 'client' ORDER BY name`).all() as {
    id: string;
    name: string;
    client_type: string | null;
    target_brand: string | null;
  }[];
  return rows.filter((r) => selfSignupAllowed(r.id)).map((r) => ({ id: r.id, name: r.name, clientType: r.client_type, brand: r.target_brand }));
}

function storeCode(orgId: string, name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  const base = (letters.slice(0, 3) || "STR").padEnd(3, "X");
  for (let i = 0; i < 50; i++) {
    const code = i === 0 ? base : `${base.slice(0, 3)}${randomInt(10, 99)}`;
    const clash = db().prepare(`SELECT 1 FROM stores WHERE org_id = ? AND code = ?`).get(orgId, code);
    if (!clash) return code;
  }
  throw new HttpError(503, "Could not pick a store code — try again.");
}

/* ── register a new store ────────────────────────────────────── */
export function registerStore(input: Record<string, unknown>) {
  const programmeId = String(input.programmeId ?? "");
  if (!selfSignupAllowed(programmeId)) throw new HttpError(400, "This programme needs an invite — ask your contact.");
  const storeName = String(input.storeName ?? "").trim().replace(/\s+/g, " ");
  const city = String(input.city ?? "").trim().replace(/\s+/g, " ");
  const kind = String(input.storeKind ?? "") as (typeof KINDS)[number];
  if (storeName.length < 3) throw new HttpError(400, "Enter the store's name as customers know it.");
  if (city.length < 2) throw new HttpError(400, "Enter the city.");
  if (!KINDS.includes(kind)) throw new HttpError(400, "Choose what kind of store it is.");
  const person = cleanPerson({ name: input.managerName, username: input.username, password: input.password, phone: input.phone }, true);
  const dupe = db().prepare(`SELECT 1 FROM stores WHERE org_id = ? AND lower(name) = lower(?) AND lower(COALESCE(city,'')) = lower(?)`).get(programmeId, storeName, city);
  if (dupe) throw new HttpError(409, "That store is already registered — ask its manager for an invite.");

  const ids = tx(() => {
    const now = nowIso();
    const storeId = newId("st");
    db()
      .prepare(
        `INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, active, created_at, status, settings)
         VALUES (?,?,?,?,?,?,0,1,?,'pending',?)`
      )
      .run(storeId, programmeId, storeName.slice(0, 80), kind, city.slice(0, 60), storeCode(programmeId, storeName), now, JSON.stringify({ contactPhone: person.phone }));
    const userId = newId("usr");
    db()
      .prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (?,?,?,?,?,'store_manager',?,?)`)
      .run(userId, programmeId, storeId, person.username, person.name, hashPassword(person.password), now);
    db().prepare(`UPDATE stores SET registered_by = ? WHERE id = ?`).run(userId, storeId);
    audit({ userId, orgId: programmeId, storeId, action: "store.self_register", entity: "store", entityId: storeId, detail: { storeName, city, kind } });
    return { storeId, userId };
  });
  return tokenFor(ids.userId);
}

/* ── invites ─────────────────────────────────────────────────── */
function newInviteCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return c;
}

export function createInvite(u: SessionUser, storeId: string, input: { role?: string; days?: number; uses?: number }) {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can invite staff.");
  const store = storeInScope(u, storeId);
  const role = input.role === "store_manager" && u.role !== "store_manager" ? "store_manager" : "advisor";
  const days = Math.min(30, Math.max(1, Math.floor(Number(input.days ?? 7)) || 7));
  const uses = Math.min(20, Math.max(1, Math.floor(Number(input.uses ?? 5)) || 5));
  const code = newInviteCode();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  db()
    .prepare(`INSERT INTO store_invites (code_hash, code_hint, store_id, role, created_by, created_at, expires_at, max_uses) VALUES (?,?,?,?,?,?,?,?)`)
    .run(sha(code), code.slice(-3), store.id, role, u.id, now, expiresAt, uses);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "invite.create", entity: "store", entityId: store.id, detail: { role, days, uses, hint: code.slice(-3) } });
  const base = (process.env.SWAPUP_PUBLIC_URL || "").replace(/\/$/, "");
  return {
    code,
    role,
    expiresAt,
    maxUses: uses,
    // Opens the store app's sign-up with the code filled in (browser version; the Android app reads the same ?invite=).
    url: `${base}/app/store/?invite=${code}`,
    deepLink: `swapupstore://join?invite=${code}&server=${encodeURIComponent(base)}`,
  };
}

export function listInvites(u: SessionUser, storeId: string) {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can see invites.");
  const store = storeInScope(u, storeId);
  return (db()
    .prepare(`SELECT code_hash, code_hint, role, created_at, expires_at, max_uses, uses, revoked_at FROM store_invites WHERE store_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(store.id) as { code_hash: string; code_hint: string; role: string; created_at: string; expires_at: string; max_uses: number; uses: number; revoked_at: string | null }[]).map((r) => ({
    id: r.code_hash.slice(0, 16),
    hint: `…${r.code_hint}`,
    role: r.role,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    uses: r.uses,
    maxUses: r.max_uses,
    state: r.revoked_at ? "revoked" : Date.parse(r.expires_at) < Date.now() ? "expired" : r.uses >= r.max_uses ? "used up" : "active",
  }));
}

export function revokeInvite(u: SessionUser, storeId: string, id: string) {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can revoke invites.");
  const store = storeInScope(u, storeId);
  const r = db()
    .prepare(`UPDATE store_invites SET revoked_at = ? WHERE store_id = ? AND substr(code_hash, 1, 16) = ? AND revoked_at IS NULL`)
    .run(nowIso(), store.id, String(id).slice(0, 16));
  if (r.changes !== 1) throw new HttpError(404, "Invite not found.");
  return { ok: true as const };
}

/** What an invite code would let you join — shown before the person fills in their details. */
export function peekInvite(raw: unknown) {
  const code = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z2-9]{8}$/.test(code)) throw new HttpError(404, "An invite code is 8 letters and numbers.");
  const inv = db().prepare(`SELECT * FROM store_invites WHERE code_hash = ?`).get(sha(code)) as
    | { store_id: string; role: string; expires_at: string; max_uses: number; uses: number; revoked_at: string | null }
    | undefined;
  if (!inv || inv.revoked_at || Date.parse(inv.expires_at) < Date.now() || inv.uses >= inv.max_uses)
    throw new HttpError(404, "That invite has expired — ask your manager for a new one.");
  const store = getStore(inv.store_id)!;
  return { code, inv, store };
}

export function joinWithInvite(input: Record<string, unknown>) {
  const { code } = peekInvite(input.inviteCode);
  const person = cleanPerson({ name: input.name, username: input.username, password: input.password, phone: input.phone }, false);
  const userId = tx(() => {
    // Re-read inside the transaction so two people racing for the last use can't both get in.
    const { inv, store } = peekInvite(code);
    if (!store.active || store.status === "rejected") throw new HttpError(409, "This store is closed in SwapUp.");
    const upd = db().prepare(`UPDATE store_invites SET uses = uses + 1 WHERE code_hash = ? AND uses < max_uses`).run(sha(code));
    if (upd.changes !== 1) throw new HttpError(409, "That invite is used up — ask your manager for a new one.");
    const id = newId("usr");
    db()
      .prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, store.org_id, store.id, person.username, person.name, inv.role, hashPassword(person.password), nowIso());
    audit({ userId: id, orgId: store.org_id, storeId: store.id, action: "user.join_invite", entity: "user", entityId: id, detail: { role: inv.role } });
    return id;
  });
  return tokenFor(userId);
}

export function invitePreview(raw: unknown) {
  const { store } = peekInvite(raw);
  const org = getOrg(store.org_id);
  return { storeName: store.name, city: store.city, programme: org?.name ?? "" };
}

/* ── programme approval ──────────────────────────────────────── */
export function reviewStore(u: SessionUser, storeId: string, input: { decision?: string; creditLimit?: number; note?: string }) {
  if (!["org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only the programme admin approves stores.");
  const store = storeInScope(u, storeId);
  const decision = input.decision === "reject" ? "rejected" : input.decision === "approve" ? "active" : null;
  if (!decision) throw new HttpError(400, "Approve or reject.");
  const note = String(input.note ?? "").trim().slice(0, 300) || null;
  let limit = store.credit_limit;
  if (decision === "active") {
    limit = Number(input.creditLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw new HttpError(400, "Set the store's credit limit (whole rupees) to approve it.");
  } else if (!note || note.length < 4) throw new HttpError(400, "Say why the store is rejected — the manager will see it.");
  tx(() => {
    db().prepare(`UPDATE stores SET status = ?, credit_limit = ?, review_note = ?, active = ? WHERE id = ?`).run(decision, limit, note, decision === "rejected" ? 0 : 1, store.id);
    audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: `store.${decision === "active" ? "approve" : "reject"}`, entity: "store", entityId: store.id, detail: { limit, note } });
  });
  return getStore(store.id) as StoreRow;
}

export function pendingStores(u: SessionUser) {
  if (!["org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Not allowed.");
  const rows = db()
    .prepare(
      `SELECT s.*, o.name AS org_name, us.name AS manager_name, us.username AS manager_username
       FROM stores s JOIN orgs o ON o.id = s.org_id LEFT JOIN users us ON us.id = s.registered_by
       WHERE s.status = 'pending' ${u.role === "org_admin" ? "AND s.org_id = ?" : ""} ORDER BY s.created_at`
    )
    .all(...(u.role === "org_admin" ? [u.orgId] : [])) as (StoreRow & { org_name: string; manager_name: string | null; manager_username: string | null; settings: string })[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    kind: r.kind,
    code: r.code,
    programme: r.org_name,
    managerName: r.manager_name,
    managerUsername: r.manager_username,
    contactPhone: parseJson<{ contactPhone?: string }>(r.settings, {}).contactPhone ?? null,
    createdAt: r.created_at,
  }));
}
