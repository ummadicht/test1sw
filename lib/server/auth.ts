import { cookies, headers } from "next/headers";
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";
import { queryOne, parseJson } from "./db";

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
const KC_ID_TOKEN_COOKIE = "swapup_kc_id_token";
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

export async function authenticate(username: string, password: string): Promise<SessionUser | null> {
  const { getKeycloakConfig, authenticateViaKeycloakPassword } = await import("./keycloak");
  const kcCfg = getKeycloakConfig();
  if (kcCfg.enabled) {
    const kcRes = await authenticateViaKeycloakPassword(username, password);
    if (kcRes.matched && kcRes.user) {
      return sessionFor(kcRes.user);
    }
    if (!kcCfg.allowLocalFallback && !kcRes.unreachable) {
      return null;
    }
  }

  const row = await queryOne<UserRow>("SELECT * FROM users WHERE username = $1", [(username || "").trim()]);
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

async function isHttpsRequest(): Promise<boolean> {
  try {
    const hs = await headers();
    const proto = hs.get("x-forwarded-proto") || "";
    if (proto.toLowerCase().includes("https")) return true;
    const host = hs.get("x-forwarded-host") || hs.get("host") || "";
    if (host.endsWith(".run.app")) return true;
  } catch {
    // ignore outside request context
  }
  return process.env.NODE_ENV === "production";
}

export async function setSession(u: SessionUser): Promise<void> {
  const jar = await cookies();
  const https = await isHttpsRequest();
  jar.set(COOKIE, encode(u), {
    httpOnly: true,
    sameSite: https ? "none" : "lax",
    secure: https,
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function setKeycloakIdTokenCookie(idToken: string): Promise<void> {
  const jar = await cookies();
  const https = await isHttpsRequest();
  jar.set(KC_ID_TOKEN_COOKIE, idToken, {
    httpOnly: true,
    sameSite: https ? "none" : "lax",
    secure: https,
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function getKeycloakIdTokenCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(KC_ID_TOKEN_COOKIE)?.value ?? null;
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(KC_ID_TOKEN_COOKIE);
}

/**
 * The signed-in user, re-checked against the database so a deactivated user or
 * a changed role takes effect on the next request rather than at cookie expiry.
 */
export async function getSession(): Promise<SessionUser | null> {
  const hs = await headers();
  const h = hs.get("authorization") || "";
  if (/^Device\s/i.test(h)) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const token = m ? m[1] : (await cookies()).get(COOKIE)?.value;
  let u = decode(token);

  // If the caller passed a 3-part Keycloak JWT as Bearer token, verify & map it
  if (!u && m && token && token.split(".").length === 3) {
    const { verifyKeycloakJwt, syncKeycloakUserToDb } = await import("./keycloak");
    const claims = await verifyKeycloakJwt(token);
    if (claims) {
      const synced = await syncKeycloakUserToDb(claims);
      if (synced) {
        u = sessionFor(synced);
      }
    }
  }

  if (!u) return null;
  const row = await queryOne<Pick<UserRow, "role" | "org_id" | "store_id" | "active" | "name">>(
    "SELECT role, org_id, store_id, active, name FROM users WHERE id = $1",
    [u.id]
  );
  if (!row || !row.active || row.role !== u.role || row.org_id !== u.orgId || row.store_id !== u.storeId) return null;
  // Unlocked on a store tablet: only while that tablet is still enrolled.
  if (u.dev) {
    const dev = await queryOne("SELECT 1 FROM store_devices WHERE id = $1 AND revoked_at IS NULL", [u.dev]);
    if (!dev) return null;
  }
  if (m && (u.role === "advisor" || u.role === "store_manager") && storeAppTooOld(hs.get("x-swapup-app"), process.env.SWAPUP_STORE_MIN_VERSION)) {
    throw new HttpError(426, UPDATE_STORE);
  }
  return { ...u, name: row.name };
}

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
    repairPolicy: { labourByTier: { Z: 525, S: 425, other: 350 } as Record<string, number>, gstBp: 1800, carePlusFeeDefault: 2349 },
    bandMinBp: 200,
    bandMaxBp: 500,
    quoteValidityDays: null as number | null,
    thresholds: { upgradeRatio: 0.5, repairRatio: 0.2, materialGap: 500, supportSoonYears: 1, oldAgeYears: 5 },
  };
}

export async function orgSettings(orgId: string): Promise<OrgSettings> {
  const row = await queryOne<{ settings: string }>("SELECT settings FROM orgs WHERE id = $1", [orgId]);
  const d = orgSettingsDefaults();
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
