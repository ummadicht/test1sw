import { createHash, randomBytes } from "node:crypto";
import { db, tx, nowIso, newId, audit } from "./db";
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

const REMOVED = "This tablet was removed from the store. A manager can set it up again.";
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
export function createStoreDevice(u: SessionUser, input: { name?: unknown }) {
  if (u.role !== "store_manager") throw new HttpError(403, "Only a store manager can set up a store tablet.");
  // A session unlocked by PIN on a tablet can't enrol another: each new tablet
  // would otherwise mint fresh PIN guesses (and outlive the tablet's removal).
  if (u.dev) throw new HttpError(403, "Sign in with your username and password to set up a store tablet.");
  const store = ownStore(u);
  // The tablet could not unlock anyone at a rejected store, so don't hand out a token that only fails.
  if (store.status === "rejected") throw new HttpError(409, CLOSED);
  const problem = deviceNameProblem(input.name);
  if (problem) throw new HttpError(400, problem);
  const name = String(input.name).trim().replace(/\s+/g, " ");
  const active = (db().prepare(`SELECT COUNT(*) AS n FROM store_devices WHERE store_id = ? AND revoked_at IS NULL`).get(store.id) as { n: number }).n;
  if (active >= MAX_TABLETS_PER_STORE) throw new HttpError(409, `This store already has ${MAX_TABLETS_PER_STORE} tablets. Remove one first.`);
  const deviceToken = `sdt_${randomBytes(32).toString("base64url")}`;
  const id = newId("dev");
  const createdAt = nowIso();
  tx(() => {
    db()
      .prepare(`INSERT INTO store_devices (id, store_id, org_id, name, token_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, store.id, store.org_id, name, sha(deviceToken), u.id, createdAt);
    audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store_device.create", entity: "store_device", entityId: id, detail: { name } });
  });
  return {
    deviceToken,
    device: { id, name, createdAt },
    store: { id: store.id, name: store.name, code: store.code, city: store.city },
  };
}

export type StoreDeviceView = { id: string; name: string; createdAt: string; createdBy: string | null; lastSeenAt: string | null; revokedAt: string | null };

/** The store's tablets, newest first, removed ones included (so a manager can see what was taken off and when). */
export function listStoreDevices(u: SessionUser, storeId?: string | null): StoreDeviceView[] {
  let store: StoreRow;
  if (u.role === "store_manager") store = ownStore(u);
  else if (u.role === "org_admin" || u.role === "platform") {
    if (!storeId) throw new HttpError(400, "Choose a store.");
    store = storeInScope(u, storeId);
  } else throw new HttpError(403, "Only a store manager can see the store's tablets.");
  const rows = db()
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.revoked_at, u.name AS created_by_name
         FROM store_devices d LEFT JOIN users u ON u.id = d.created_by
        WHERE d.store_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 100`
    )
    .all(store.id) as { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; created_by_name: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, createdBy: r.created_by_name, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at }));
}

/** Remove a tablet (lost, replaced). Its token stops working on its next request. Removing twice is fine. */
export function revokeStoreDevice(u: SessionUser, id: string) {
  if (u.role !== "store_manager" && u.role !== "org_admin") throw new HttpError(403, "Only a store manager can remove a store tablet.");
  const device = db().prepare(`SELECT * FROM store_devices WHERE id = ?`).get(String(id ?? "").slice(0, 64)) as DeviceRow | undefined;
  const store = device ? getStore(device.store_id) : null;
  // Another store's tablet reads as not found, not forbidden — a 403 would confirm it exists.
  if (!device || !store || !canSeeStore(u, store)) throw new HttpError(404, "Tablet not found.");
  tx(() => {
    const r = db().prepare(`UPDATE store_devices SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), u.id, device.id);
    if (r.changes !== 1) return;
    // Its PIN failures are kept: they still count towards each person's budget
    // across all tablets, so removing and re-adding tablets never buys guesses.
    audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store_device.revoke", entity: "store_device", entityId: device.id, detail: { name: device.name } });
  });
  return { ok: true as const };
}

/** Set your own PIN while signed in (the app's Settings → Change my PIN). */
export function setOwnPin(u: SessionUser, input: { password?: unknown; pin?: unknown }) {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "PINs are for store staff, to unlock the store tablet.");
  const problem = pinProblem(input.pin);
  if (problem) throw new HttpError(400, problem);
  const row = db().prepare(`SELECT password_hash FROM users WHERE id = ?`).get(u.id) as { password_hash: string } | undefined;
  // A wrong password is a 403, not a 401 — it must not sign the person out of the app.
  if (!row || !verifyPassword(typeof input.password === "string" ? input.password : "", row.password_hash)) throw new HttpError(403, "That password isn't right.");
  const pinHash = hashPassword(input.pin as string);
  db().prepare(`UPDATE users SET pin_hash = ?, pin_set_at = ? WHERE id = ?`).run(pinHash, nowIso(), u.id);
  audit({ userId: u.id, orgId: u.orgId, storeId: u.storeId, action: "user.set_pin", entity: "user", entityId: u.id });
  return { ok: true as const };
}

/* ── the tablet's side (device token) ───────────────────────── */

/** The tablet behind "Authorization: Device <token>", or a 401 that tells the tablet to forget its token. */
export function requireDevice(req: Request): TabletContext {
  const m = /^Device\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, REMOVED);
  const device = db().prepare(`SELECT * FROM store_devices WHERE token_hash = ? AND revoked_at IS NULL`).get(sha(m[1])) as DeviceRow | undefined;
  const store = device ? getStore(device.store_id) : null;
  if (!device || !store) throw new HttpError(401, REMOVED);
  if (store.status === "rejected") throw new HttpError(403, CLOSED);
  const now = Date.now();
  if (!device.last_seen_at || Date.parse(device.last_seen_at) < now - SEEN_EVERY_MS) {
    db().prepare(`UPDATE store_devices SET last_seen_at = ? WHERE id = ?`).run(new Date(now).toISOString(), device.id);
  }
  return { device, store };
}

/** "Who's serving?" — the tablet, its store, and the store's active counter staff by name. */
export function tabletInfo(ctx: TabletContext) {
  const org = getOrg(ctx.store.org_id);
  const staff = db()
    .prepare(
      `SELECT id, name, role, pin_hash IS NOT NULL AS has_pin FROM users
        WHERE store_id = ? AND active = 1 AND role IN ('advisor','store_manager')
        ORDER BY name COLLATE NOCASE, id`
    )
    .all(ctx.store.id) as { id: string; name: string; role: Role; has_pin: number }[];
  return {
    device: { id: ctx.device.id, name: ctx.device.name },
    store: { id: ctx.store.id, name: ctx.store.name, code: ctx.store.code, city: ctx.store.city, status: ctx.store.status ?? "active" },
    org: { name: org?.name ?? "", demo: !!org?.demo },
    staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role], hasPin: !!s.has_pin })),
  };
}

/** Unlock the tablet for one person with their PIN → the same staff token a password sign-in gives. */
export function tabletUnlock(ctx: TabletContext, input: { userId?: unknown; pin?: unknown }) {
  const pin = typeof input.pin === "string" ? input.pin : "";
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, "The PIN is 4 digits.");
  const person = staffMember(ctx, input.userId);
  // A lock (this tablet) or a spent budget (all tablets) answers before any
  // secret is checked, so a locked person's guesses learn nothing — not even from timing.
  if (person) refuseIfLocked(ctx, person, "pin");
  // Always run the KDF once, like authenticate(): someone not on the staff, or
  // with no PIN yet, costs the same as a wrong PIN.
  const ok = verifyPassword(pin, person?.pin_hash || DUMMY_HASH);
  if (!person) throw new HttpError(404, NOT_STAFF);
  if (!person.pin_hash) throw new HttpError(409, "Set your PIN first.");
  const v = settleTry(ctx, person, ok, "pin");
  if (v.kind === "locked") throw lockedError(v.until);
  if (v.kind === "wrong") throw new HttpError(403, `Wrong PIN — ${tries(v.triesLeft)} left.`);
  audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.unlock", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id } });
  return tokenResponse({ ...sessionFor(person), dev: ctx.device.id });
}

/** First PIN, or a forgotten one: proved with the person's account password, then signed in. */
export function tabletSetPin(ctx: TabletContext, input: { userId?: unknown; password?: unknown; pin?: unknown }) {
  const problem = pinProblem(input.pin);
  if (problem) throw new HttpError(400, problem);
  const pin = input.pin as string;
  const password = typeof input.password === "string" ? input.password : "";
  // An empty box is a slip, not a guess — don't spend one of their tries on it.
  if (!password) throw new HttpError(400, "Enter your password.");
  const person = staffMember(ctx, input.userId);
  // This tablet's lock answers before the password is checked (no timing tell).
  // The all-tablets PIN budget does not apply: setting a new PIN with the
  // password is exactly how a person gets out of it.
  if (person) refuseIfLocked(ctx, person, "password");
  const ok = verifyPassword(password, person?.password_hash || DUMMY_HASH);
  if (!person) throw new HttpError(404, NOT_STAFF);
  const v = settleTry(ctx, person, ok, "password");
  if (v.kind === "locked") throw lockedError(v.until);
  if (v.kind === "wrong") throw new HttpError(403, `That password isn't right — ${tries(v.triesLeft)} left.`);
  // Proven by password: the new PIN replaces the old, and every tablet's count for this person starts again.
  const pinHash = hashPassword(pin);
  tx(() => {
    db().prepare(`UPDATE users SET pin_hash = ?, pin_set_at = ? WHERE id = ?`).run(pinHash, nowIso(), person.id);
    db().prepare(`DELETE FROM pin_attempts WHERE user_id = ?`).run(person.id);
    audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.set_pin", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id } });
  });
  return tokenResponse({ ...sessionFor(person), dev: ctx.device.id });
}

/* ── helpers ─────────────────────────────────────────────────── */

/** An active advisor or store manager of THIS tablet's store — never anyone else, whatever id is sent. */
function staffMember(ctx: TabletContext, userId: unknown): StaffRow | null {
  if (typeof userId !== "string" || !userId || userId.length > 64) return null;
  return (
    (db()
      .prepare(
        `SELECT id, org_id, store_id, username, name, role, password_hash, pin_hash FROM users
          WHERE id = ? AND store_id = ? AND active = 1 AND role IN ('advisor','store_manager')`
      )
      .get(userId, ctx.store.id) as StaffRow | undefined) ?? null
  );
}

function runningLock(deviceId: string, userId: string): string | null {
  const a = db().prepare(`SELECT locked_until FROM pin_attempts WHERE device_id = ? AND user_id = ?`).get(deviceId, userId) as { locked_until: string | null } | undefined;
  return a && isLocked(a.locked_until, Date.now()) ? a.locked_until : null;
}

/**
 * 429 before any secret is checked when this person is locked on this tablet,
 * or (PIN only) has used up their budget across all of the store's tablets in
 * the last day — a budget only a new PIN, set with their password, resets.
 */
function refuseIfLocked(ctx: TabletContext, person: StaffRow, what: "pin" | "password"): void {
  const lock = runningLock(ctx.device.id, person.id);
  if (lock) throw lockedError(lock);
  if (what !== "pin") return;
  const since = new Date(Date.now() - PERSON_PIN_WINDOW_MS).toISOString();
  const spent = (db()
    .prepare(`SELECT COALESCE(SUM(failures), 0) AS n FROM pin_attempts WHERE user_id = ? AND last_failure_at > ?`)
    .get(person.id, since) as { n: number }).n;
  if (spent >= PERSON_PIN_BUDGET)
    throw new HttpError(429, `Too many wrong PINs for ${person.name.split(" ")[0]} on this store's tablets. Set a new PIN with your password.`);
}

function lockedError(until: string): HttpError {
  const mins = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
  return new HttpError(429, `Too many wrong PINs. Try again in ${mins} ${mins === 1 ? "minute" : "minutes"}, or ask your manager.`);
}

type Verdict = { kind: "ok" } | { kind: "locked"; until: string } | { kind: "wrong"; triesLeft: number };

/**
 * Count one try (a PIN, or the password on set-pin) for this person on this
 * tablet. The lock is re-read inside one write transaction, so guesses sent in
 * parallel are counted one at a time and none slips past a lock that another
 * just set — a locked person gets 429 even with the right PIN. The secret was
 * already checked by the caller, outside the transaction (the KDF is slow and
 * must not hold the write lock). `onOk` runs in the same transaction.
 */
function settleTry(ctx: TabletContext, person: StaffRow, ok: boolean, what: "pin" | "password", onOk?: () => void): Verdict {
  return tx((): Verdict => {
    const now = Date.now();
    const a = db().prepare(`SELECT failures, locked_until FROM pin_attempts WHERE device_id = ? AND user_id = ?`).get(ctx.device.id, person.id) as
      | { failures: number; locked_until: string | null }
      | undefined;
    if (a?.locked_until && isLocked(a.locked_until, now)) return { kind: "locked", until: a.locked_until };
    if (ok) {
      // A correct try wipes the slate for this person on this tablet.
      db().prepare(`DELETE FROM pin_attempts WHERE device_id = ? AND user_id = ?`).run(ctx.device.id, person.id);
      onOk?.();
      return { kind: "ok" };
    }
    // A lock that has run its course starts the count again from zero.
    const next = afterWrongPin(a?.locked_until ? 0 : (a?.failures ?? 0), now);
    const until = next.lockedUntil === null ? null : new Date(next.lockedUntil).toISOString();
    db()
      .prepare(
        `INSERT INTO pin_attempts (device_id, user_id, failures, locked_until, last_failure_at) VALUES (?,?,?,?,?)
         ON CONFLICT (device_id, user_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at`
      )
      .run(ctx.device.id, person.id, next.failures, until, new Date(now).toISOString());
    if (until) {
      // Worth a line in the audit: someone may be guessing a colleague's PIN.
      audit({ userId: person.id, orgId: person.org_id, storeId: ctx.store.id, action: "tablet.pin_locked", entity: "user", entityId: person.id, detail: { deviceId: ctx.device.id, after: what } });
      return { kind: "locked", until };
    }
    return { kind: "wrong", triesLeft: next.triesLeft };
  });
}
