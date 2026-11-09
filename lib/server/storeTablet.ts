import { createHash, randomBytes } from "node:crypto";
import { query, queryOne, execute, tx, nowIso, newId, audit } from "./db";
import { HttpError, ROLE_LABEL, hashPassword, verifyPassword, sessionFor, type Role, type SessionUser } from "./auth";
import { canSeeStore, getOrg, getStore, ownStore, storeInScope, type StoreRow } from "./scope";
import { tokenResponse } from "./mobileAuth";
import { afterWrongPin, deviceNameProblem, isLocked, pinProblem, MAX_TABLETS_PER_STORE, PERSON_PIN_BUDGET, PERSON_PIN_WINDOW_MS } from "../domain/storeTablet";

/**
 * THE STORE TABLET (docs/STORE-TABLET.md).
 *
 * A store manager enrolls the counter tablet once; it keeps a long-lived device
 * token bound to that ONE store, sent as "Authorization: Device <token>". The
 * token alone can do three things — list the store's counter staff, unlock one
 * of them with their PIN, set a PIN with the person's password — and nothing
 * else: unlocking hands back the same 12 h staff token a password sign-in
 * gives, and everything after that is the ordinary staff API.
 *
 * Every request re-reads the device row, so a manager's Remove takes effect on
 * the tablet's very next call. Only the token's sha256 is stored.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The shape and cost of a real hash, for the constant-cost check when there is nobody to check against. */
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(64)}`;

const REMOVED = "Tablet removed — a manager can set it up again.";
const CLOSED = "This store is closed in SwapUp.";
const NOT_STAFF = "Not on this store's staff.";
/** "Last seen" only needs to say roughly when — and the tablet polls — so write it at most once a minute. */
const SEEN_EVERY_MS = 60_000;

type DeviceRow = {
  id: string;
  store_id: string;
  org_id: string;
  name: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

export type TabletContext = { device: DeviceRow; store: StoreRow };

type StaffRow = {
  id: string;
  org_id: string;
  store_id: string | null;
  username: string;
  name: string;
  role: Role;
  password_hash: string;
  pin_hash: string | null;
};

const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`;

/* ── the manager's side (staff session) ─────────────────────── */

/** Enroll this device as the store's tablet. The token is in this response once and never again. */
export async function createStoreDevice(u: SessionUser, input: { name?: unknown }) {
  if (u.role !== "store_manager") throw new HttpError(403, "Only a store manager can set up a store tablet.");
  if (u.dev) throw new HttpError(403, "Sign in with your password to set up a tablet.");
  const store = await ownStore(u);
  if (store.status === "rejected") throw new HttpError(409, CLOSED);
  const problem = deviceNameProblem(input.name);
  if (problem) throw new HttpError(400, problem);
  const name = String(input.name).trim().replace(/\s+/g, " ");
  const activeRow = await queryOne<{ n: string | number }>(`SELECT COUNT(*) AS n FROM store_devices WHERE store_id = $1 AND revoked_at IS NULL`, [store.id]);
  const active = Number(activeRow?.n || 0);
  if (active >= MAX_TABLETS_PER_STORE) throw new HttpError(409, `This store has ${MAX_TABLETS_PER_STORE} tablets — remove one first.`);
  const deviceToken = `sdt_${randomBytes(32).toString("base64url")}`;
  const id = newId("dev");
  const createdAt = nowIso();
  await tx(async () => {
    await execute(
      `INSERT INTO store_devices (id, store_id, org_id, name, token_hash, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, store.id, store.org_id, name, sha(deviceToken), u.id, createdAt]
    );
    await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store_device.create", entity: "store_device", entityId: id, detail: { name } });
  });
  return {
    deviceToken,
    device: { id, name, createdAt },
    store: { id: store.id, name: store.name, code: store.code, city: store.city },
  };
}

export type StoreDeviceView = { id: string; name: string; createdAt: string; createdBy: string | null; lastSeenAt: string | null; revokedAt: string | null };

/** The store's tablets, newest first, removed ones included (so a manager can see what was taken off and when). */
export async function listStoreDevices(u: SessionUser, storeId?: string | null): Promise<StoreDeviceView[]> {
  let store: StoreRow;
  if (u.role === "store_manager") store = await ownStore(u);
  else if (u.role === "org_admin" || u.role === "platform") {
    if (!storeId) throw new HttpError(400, "Choose a store.");
    store = await storeInScope(u, storeId);
  } else throw new HttpError(403, "Only a store manager can see the store's tablets.");
  const rows = await query<{ id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; created_by_name: string | null }>(
    `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.revoked_at, u.name AS created_by_name
       FROM store_devices d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.store_id = $1 ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
    [store.id]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, createdBy: r.created_by_name, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at }));
}

/** Remove a tablet (lost, replaced). Its token stops working on its next request. Removing twice is fine. */
export async function revokeStoreDevice(u: SessionUser, id: string) {
  if (u.role !== "store_manager" && u.role !== "org_admin") throw new HttpError(403, "Only a store manager can remove a store tablet.");
  const device = await queryOne<DeviceRow>(`SELECT * FROM store_devices WHERE id = $1`, [String(id ?? "").slice(0, 64)]);
  const store = device ? await getStore(device.store_id) : null;
  if (!device || !store || !(await canSeeStore(u, store))) throw new HttpError(404, "Tablet not found.");
  await tx(async () => {
    const r = await execute(`UPDATE store_devices SET revoked_at = $1, revoked_by = $2 WHERE id = $3 AND revoked_at IS NULL`, [nowIso(), u.id, device.id]);
    if (r.rowCount !== 1) return;
    await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store_device.revoke", entity: "store_device", entityId: device.id, detail: { name: device.name } });
  });
  return { ok: true as const };
}

/** Set your own PIN while signed in (the app's Settings → Change my PIN). */
export async function setOwnPin(u: SessionUser, input: { password?: unknown; pin?: unknown }) {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "PINs are for store staff, to unlock the store tablet.");
  const problem = pinProblem(input.pin);
  if (problem) throw new HttpError(400, problem);
  const row = await queryOne<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
  if (!row || !verifyPassword(typeof input.password === "string" ? input.password : "", row.password_hash)) throw new HttpError(403, "That password isn't right.");
  const pinHash = hashPassword(input.pin as string);
  await execute(`UPDATE users SET pin_hash = $1, pin_set_at = $2 WHERE id = $3`, [pinHash, nowIso(), u.id]);
  await audit({ userId: u.id, orgId: u.orgId, storeId: u.storeId, action: "user.set_pin", entity: "user", entityId: u.id });
  return { ok: true as const };
}

/* ── the tablet's side (device token) ───────────────────────── */

/** The tablet behind "Authorization: Device <token>", or a 401 that tells the tablet to forget its token. */
export async function requireDevice(req: Request): Promise<TabletContext> {
  const m = /^Device\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, REMOVED);
  const device = await queryOne<DeviceRow>(`SELECT * FROM store_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [sha(m[1])]);
  const store = device ? await getStore(device.store_id) : null;
  if (!device || !store) throw new HttpError(401, REMOVED);
  if (store.status === "rejected") throw new HttpError(403, CLOSED);
  const now = Date.now();
  if (!device.last_seen_at || Date.parse(device.last_seen_at) < now - SEEN_EVERY_MS) {
    await execute(`UPDATE store_devices SET last_seen_at = $1 WHERE id = $2`, [new Date(now).toISOString(), device.id]);
  }
  return { device, store };
}

/** "Who's serving?" — the tablet, its store, and the store's active counter staff by name. */
export async function tabletInfo(ctx: TabletContext) {
  const org = await getOrg(ctx.store.org_id);
  const staff = await query<{ id: string; name: string; role: Role; has_pin: number }>(
    `SELECT id, name, role, (pin_hash IS NOT NULL)::int AS has_pin FROM users
      WHERE store_id = $1 AND active = 1 AND role IN ('advisor','store_manager')
      ORDER BY name, id`,
    [ctx.store.id]
  );
  return {
    device: { id: ctx.device.id, name: ctx.device.name },
    store: { id: ctx.store.id, name: ctx.store.name, code: ctx.store.code, city: ctx.store.city, status: ctx.store.status ?? "active" },
    org: { name: org?.name ?? "", demo: !!org?.demo },
    staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role], hasPin: !!s.has_pin })),
  };
}

/** Unlock the tablet for one person with their PIN → the same staff token a password sign-in gives. */
export async function tabletUnlock(ctx: TabletContext, input: { userId?: unknown; pin?: unknown }) {
  const pin = typeof input.pin === "string" ? input.pin : "";
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, "The PIN is 4 digits.");
  const person = await staffMember(ctx, input.userId);
  if (person) await refuseIfLocked(ctx, person, "pin");
  const ok = verifyPassword(pin, person?.pin_hash || DUMMY_HASH);
  if (!person) throw new HttpError(404, NOT_STAFF);
  if (!person.pin_hash) throw new HttpError(409, "Set your PIN first.");
  const v = await settleTry(ctx, person, ok, "pin");
  if (v.kind === "locked") throw lockedError(v.until);
  if (v.kind === "wrong") throw new HttpError(403, `Wrong PIN — ${tries(v.triesLeft)} left.`);
  await audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.unlock", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id } });
  return tokenResponse({ ...sessionFor(person), dev: ctx.device.id });
}

/** First PIN, or a forgotten one: proved with the person's account password, then signed in. */
export async function tabletSetPin(ctx: TabletContext, input: { userId?: unknown; password?: unknown; pin?: unknown }) {
  const problem = pinProblem(input.pin);
  if (problem) throw new HttpError(400, problem);
  const pin = input.pin as string;
  const password = typeof input.password === "string" ? input.password : "";
  if (!password) throw new HttpError(400, "Enter your password.");
  const person = await staffMember(ctx, input.userId);
  if (person) await refuseIfLocked(ctx, person, "password");
  const ok = verifyPassword(password, person?.password_hash || DUMMY_HASH);
  if (!person) throw new HttpError(404, NOT_STAFF);
  const v = await settleTry(ctx, person, ok, "password");
  if (v.kind === "locked") throw lockedError(v.until);
  if (v.kind === "wrong") throw new HttpError(403, `That password isn't right — ${tries(v.triesLeft)} left.`);
  const pinHash = hashPassword(pin);
  await tx(async () => {
    await execute(`UPDATE users SET pin_hash = $1, pin_set_at = $2 WHERE id = $3`, [pinHash, nowIso(), person.id]);
    await execute(`DELETE FROM pin_attempts WHERE user_id = $1`, [person.id]);
    await audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.set_pin", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id } });
  });
  return tokenResponse({ ...sessionFor(person), dev: ctx.device.id });
}

/* ── helpers ─────────────────────────────────────────────────── */

/** An active advisor or store manager of THIS tablet's store — never anyone else, whatever id is sent. */
async function staffMember(ctx: TabletContext, userId: unknown): Promise<StaffRow | null> {
  if (typeof userId !== "string" || !userId || userId.length > 64) return null;
  return queryOne<StaffRow>(
    `SELECT id, org_id, store_id, username, name, role, password_hash, pin_hash FROM users
      WHERE id = $1 AND store_id = $2 AND active = 1 AND role IN ('advisor','store_manager')`,
    [userId, ctx.store.id]
  );
}

async function runningLock(deviceId: string, userId: string): Promise<string | null> {
  const a = await queryOne<{ locked_until: string | null }>(
    `SELECT locked_until FROM pin_attempts WHERE device_id = $1 AND user_id = $2`,
    [deviceId, userId]
  );
  return a && isLocked(a.locked_until, Date.now()) ? a.locked_until : null;
}

async function refuseIfLocked(ctx: TabletContext, person: StaffRow, what: "pin" | "password"): Promise<void> {
  const lock = await runningLock(ctx.device.id, person.id);
  if (lock) throw lockedError(lock);
  if (what !== "pin") return;
  const since = new Date(Date.now() - PERSON_PIN_WINDOW_MS).toISOString();
  const spentRow = await queryOne<{ n: string | number }>(
    `SELECT COALESCE(SUM(failures), 0) AS n FROM pin_attempts WHERE user_id = $1 AND last_failure_at > $2`,
    [person.id, since]
  );
  const spent = Number(spentRow?.n || 0);
  if (spent >= PERSON_PIN_BUDGET)
    throw new HttpError(429, `Too many wrong PINs for ${person.name.split(" ")[0]} — set a new PIN.`);
}

function lockedError(until: string): HttpError {
  const mins = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
  return new HttpError(429, `Too many wrong PINs — try in ${mins} ${mins === 1 ? "minute" : "minutes"}.`);
}

type Verdict = { kind: "ok" } | { kind: "locked"; until: string } | { kind: "wrong"; triesLeft: number };

async function settleTry(ctx: TabletContext, person: StaffRow, ok: boolean, what: "pin" | "password", onOk?: () => void): Promise<Verdict> {
  return tx(async (): Promise<Verdict> => {
    const now = Date.now();
    const a = await queryOne<{ failures: number; locked_until: string | null }>(
      `SELECT failures, locked_until FROM pin_attempts WHERE device_id = $1 AND user_id = $2`,
      [ctx.device.id, person.id]
    );
    if (a?.locked_until && isLocked(a.locked_until, now)) return { kind: "locked", until: a.locked_until };
    if (ok) {
      await execute(`DELETE FROM pin_attempts WHERE device_id = $1 AND user_id = $2`, [ctx.device.id, person.id]);
      onOk?.();
      return { kind: "ok" };
    }
    const next = afterWrongPin(a?.locked_until ? 0 : (a?.failures ?? 0), now);
    const until = next.lockedUntil === null ? null : new Date(next.lockedUntil).toISOString();
    await execute(
      `INSERT INTO pin_attempts (device_id, user_id, failures, locked_until, last_failure_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id, user_id) DO UPDATE SET failures = EXCLUDED.failures, locked_until = EXCLUDED.locked_until, last_failure_at = EXCLUDED.last_failure_at`,
      [ctx.device.id, person.id, next.failures, until, new Date(now).toISOString()]
    );
    if (until) {
      await audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.pin_locked", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id, after: what } });
      return { kind: "locked", until };
    }
    return { kind: "wrong", triesLeft: next.triesLeft };
  });
}
