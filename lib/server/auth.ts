import { cookies, headers } from "next/headers";
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";
import { db, parseJson } from "./db";

/**
 * Five roles, one tenant rule.
 *
 *   platform       SwapUp staff — onboards clients and partners, sees everything
 *   org_admin      a client's programme owner (e.g. the brand's service network HQ):
 *                  stores, credit limits, campaigns, catalogues, reports
 *   store_manager  one store: the counter, its credit line, pickups, its advisors
 *   advisor        one store: the counter only
 *   partner        the buyback partner's operations team: pickups, verification,
 *                  settlement and rate cards for the clients that use it
 *
 * Tenant rule: every read and write is scoped by the SESSION's org/store, never
 * by an id the client sends. A record outside the caller's scope is reported as
 * not found (404), not forbidden — a 403 would confirm it exists.
 */
export type Role = "platform" | "org_admin" | "store_manager" | "advisor" | "partner";
export const ALL_ROLES: Role[] = ["platform", "org_admin", "store_manager", "advisor", "partner"];

export const ROLE_LABEL: Record<Role, string> = {
  platform: "SwapUp platform",
  org_admin: "Programme admin",
  store_manager: "Store manager",
  advisor: "Counter advisor",
  partner: "Buyback partner",
};

export type SessionUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  orgId: string;
  storeId: string | null;
  exp: number;
  /**
   * Set when the session came from unlocking a store tablet with a PIN: the
   * tablet's store_devices id. getSession() ends the session the moment that
   * tablet is removed, and such a session can't enrol another tablet.
   */
  dev?: string;
};

const COOKIE = "swapup_session";
const MAX_AGE_S = 60 * 60 * 12; // one shift and a bit

let cachedSecret: string | null = null;
function secret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.SWAPUP_SESSION_SECRET;
  if (s && s.length >= 24) return (cachedSecret = s);
  if (process.env.NODE_ENV === "production") {
    // Lazy, so `next build` (no runtime env) still succeeds; a production
    // REQUEST without a real secret fails loudly instead of signing with a default.
    throw new Error("SWAPUP_SESSION_SECRET must be set (24+ chars) in production — the cookie carries role and org.");
  }
  return (cachedSecret = "swapup-dev-secret-not-for-production-use");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = (stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

function encode(u: SessionUser): string {
  const body = Buffer.from(JSON.stringify(u), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const u = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionUser;
    if (!u?.id || !ALL_ROLES.includes(u.role) || !u.orgId) return null;
    if (!u.exp || u.exp < Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

type UserRow = {
  id: string;
  org_id: string;
  store_id: string | null;
  username: string;
  name: string;
  role: Role;
  password_hash: string;
  active: number;
};

export function authenticate(username: string, password: string): SessionUser | null {
  const row = db().prepare(`SELECT * FROM users WHERE username = ?`).get((username || "").trim()) as UserRow | undefined;
  // Always run the KDF so a wrong username costs the same as a wrong password.
  const ok = verifyPassword(password || "", row?.password_hash || "scrypt$00$00");
  if (!row || !ok || !row.active) return null;
  return sessionFor(row);
}

/**
 * A fresh session (one shift, MAX_AGE_S) for a user row the caller has already
 * checked. Shared by password sign-in and the store tablet's PIN unlock, so an
 * unlocked tablet gets exactly the token a password sign-in would.
 */
export function sessionFor(row: Pick<UserRow, "id" | "username" | "name" | "role" | "org_id" | "store_id">): SessionUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    orgId: row.org_id,
    storeId: row.store_id,
    exp: Date.now() + MAX_AGE_S * 1000,
  };
}

/** The signed token itself — handed to the store app, which sends it as a Bearer token. */
export function issueToken(u: SessionUser): string {
  return encode(u);
}

export async function setSession(u: SessionUser): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, encode(u), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/**
 * The signed-in user, re-checked against the database so a deactivated user or
 * a changed role takes effect on the next request rather than at cookie expiry.
 */
export async function getSession(): Promise<SessionUser | null> {
  // The store app sends the same signed token as "Authorization: Bearer …".
  // An explicit Bearer token wins over the cookie, and is never topped up from
  // it: the browser store app at /app/store/ is on the desk's own origin, so its
  // fetches also carry whatever desk cookie that browser has — often a
  // different person (the manager signed in on the desk, an advisor in the
  // app). Cookie-first would act as the wrong user; a bad Bearer token is a 401.
  const hs = await headers();
  const h = hs.get("authorization") || "";
  // "Authorization: Device …" is the store tablet's device token
  // (docs/STORE-TABLET.md). It is never a session — it can only list the
  // store's staff and unlock one of them (lib/server/storeTablet.ts) — so it is
  // not matched below. Nor does it fall through to the cookie: the browser
  // tablet at /app/store/ shares the desk's origin, and a request that says
  // "I am the tablet" must not run as whoever is signed in on that browser's desk.
  if (/^Device\s/i.test(h)) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const token = m ? m[1] : (await cookies()).get(COOKIE)?.value;
  const u = decode(token);
  if (!u) return null;
  const row = db().prepare(`SELECT role, org_id, store_id, active, name FROM users WHERE id = ?`).get(u.id) as
    | Pick<UserRow, "role" | "org_id" | "store_id" | "active" | "name">
    | undefined;
  if (!row || !row.active || row.role !== u.role || row.org_id !== u.orgId || row.store_id !== u.storeId) return null;
  // Unlocked on a store tablet: only while that tablet is still enrolled (docs/STORE-TABLET.md).
  if (u.dev && !db().prepare(`SELECT 1 FROM store_devices WHERE id = ? AND revoked_at IS NULL`).get(u.dev)) return null;
  // Store staff on a Bearer token = SwapUp Store (the app, or its browser version): an old build is
  // refused here, before the route does anything. The desk (cookie), SwapUp Check (Ticket) and the
  // tablet's Device token never reach this line.
  if (m && (u.role === "advisor" || u.role === "store_manager") && storeAppTooOld(hs.get("x-swapup-app"), process.env.SWAPUP_STORE_MIN_VERSION)) {
    throw new HttpError(426, UPDATE_STORE);
  }
  return { ...u, name: row.name };
}

/**
 * SwapUp Store's minimum version (SUP-27). The apps are sideloaded with no over-the-air updates, so an
 * old tablet would keep showing old screens and totals. SwapUp Store sends
 * "X-SwapUp-App: store/<version>+<versionCode>" (e.g. "store/0.9.3+15") on every call; with
 * SWAPUP_STORE_MIN_VERSION set (e.g. "0.9.3"), a store-staff Bearer call whose header is missing,
 * malformed or names an older version gets 426 UPDATE_STORE. Unset or empty = the gate is off, the
 * default; it is set to the first release that sends the header once that is on /downloads, and from
 * then on refuses every older tablet (README → Deploy). A value that is not x.y.z leaves it off too,
 * and says so in the log once — "update" would send staff to /downloads for nothing.
 */
export const UPDATE_STORE = "Update SwapUp Store from /downloads.";

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const STORE_APP = /^store\/(\d{1,6})\.(\d{1,6})\.(\d{1,6})\+\d{1,9}$/;
let warnedMin = "";

export function storeAppTooOld(app: string | null, min: string | undefined): boolean {
  const want = (min ?? "").trim();
  if (!want) return false;
  const floor = VERSION.exec(want);
  if (!floor) {
    if (warnedMin !== want) console.error(`[swapup] SWAPUP_STORE_MIN_VERSION is not x.y.z — the SwapUp Store version gate is off`);
    warnedMin = want;
    return false;
  }
  const have = STORE_APP.exec((app ?? "").trim());
  if (!have) return true;
  for (let i = 1; i <= 3; i++) if (Number(have[i]) !== Number(floor[i])) return Number(have[i]) < Number(floor[i]);
  return false;
}

export class HttpError extends Error {
  status: number;
  /** More fields for the JSON body beside `error` — a machine-readable `reason` the apps branch on. */
  extra?: Record<string, string>;
  constructor(status: number, message: string, extra?: Record<string, string>) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const u = await getSession();
  if (!u) throw new HttpError(401, "Sign in to continue.");
  if (roles && !roles.includes(u.role)) throw new HttpError(403, "Your role cannot do this.");
  return u;
}

/** Where each role lands after signing in. */
export function homeFor(role: Role): string {
  switch (role) {
    case "platform":
      return "/platform";
    case "org_admin":
      return "/admin";
    case "store_manager":
      return "/store";
    case "advisor":
      return "/desk";
    case "partner":
      return "/partner";
  }
}

export type OrgSettings = ReturnType<typeof orgSettingsDefaults>;

export function orgSettingsDefaults() {
  return {
    releaseOn: "collected" as "collected" | "cleared",
    warnAt: 0.8,
    maxAgeDays: 7,
    pickupAtCount: 10,
    shortfallLiability: "store" as "store" | "partner",
    /** Labour per job by service tier, GST on parts + labour, and the plan fee when a model has none recorded. */
    repairPolicy: { labourByTier: { Z: 525, S: 425, other: 350 } as Record<string, number>, gstBp: 1800, carePlusFeeDefault: 2349 },
    bandMinBp: 200,
    bandMaxBp: 500,
    quoteValidityDays: null as number | null,
    thresholds: { upgradeRatio: 0.5, repairRatio: 0.2, materialGap: 500, supportSoonYears: 1, oldAgeYears: 5 },
  };
}

export function orgSettings(orgId: string): OrgSettings {
  const row = db().prepare(`SELECT settings FROM orgs WHERE id = ?`).get(orgId) as { settings: string } | undefined;
  const d = orgSettingsDefaults();
  // `priceiq` (a buy spread and an age limit) is retired: the markdown and the 14/90-day rule are the same everywhere.
  const { priceiq: _retired, ...s } = parseJson<Partial<OrgSettings> & { priceiq?: unknown }>(row?.settings, {});
  return {
    ...d,
    ...s,
    repairPolicy: {
      ...d.repairPolicy,
      ...(s.repairPolicy ?? {}),
      labourByTier: { ...d.repairPolicy.labourByTier, ...(s.repairPolicy?.labourByTier ?? {}) },
    },
    thresholds: { ...d.thresholds, ...(s.thresholds ?? {}) },
  };
}
