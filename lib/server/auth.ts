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
  const h = (await headers()).get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const token = m ? m[1] : (await cookies()).get(COOKIE)?.value;
  const u = decode(token);
  if (!u) return null;
  const row = db().prepare(`SELECT role, org_id, store_id, active, name FROM users WHERE id = ?`).get(u.id) as
    | Pick<UserRow, "role" | "org_id" | "store_id" | "active" | "name">
    | undefined;
  if (!row || !row.active || row.role !== u.role || row.org_id !== u.orgId || row.store_id !== u.storeId) return null;
  return { ...u, name: row.name };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  const s = parseJson<Partial<OrgSettings>>(row?.settings, {});
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
