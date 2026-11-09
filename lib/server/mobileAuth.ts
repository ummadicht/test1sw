import { createHash, randomBytes } from "node:crypto";
import { queryOne, execute, nowIso } from "./db";
import { HttpError, authenticate, issueToken, setSession, ROLE_LABEL, type SessionUser } from "./auth";
import { getOrg, getStore } from "./scope";

/**
 * The store app signs in with the same accounts as the web desk and gets the
 * same signed session as a Bearer token. Only counter staff — the app is a
 * counter tool. To continue a case on the web desk inside the app's WebView, it
 * asks for a one-time hand-off URL (60 s, single use) that sets the web cookie.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function userPayload(u: SessionUser) {
  const org = await getOrg(u.orgId);
  const store = u.storeId ? await getStore(u.storeId) : null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    org: org ? { id: org.id, name: org.name, demo: !!org.demo } : null,
    store: store ? { id: store.id, name: store.name, code: store.code, city: store.city, kind: store.kind, status: store.status ?? "active", reviewNote: store.review_note ?? null } : null,
  };
}

/** What the store app gets when someone signs in — by password, or by PIN on the store tablet. One shape, one token. */
export async function tokenResponse(u: SessionUser) {
  return { token: issueToken(u), expiresAt: new Date(u.exp).toISOString(), user: await userPayload(u) };
}

export async function tokenLogin(username: string, password: string) {
  const u = await authenticate(username, password);
  if (!u) return null;
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "The store app is for store staff. Use the web console for your role.");
  return tokenResponse(u);
}

/** Only same-site paths into the counter: never an absolute URL, never back into auth. */
function safeNext(n: unknown): string {
  const s = typeof n === "string" ? n : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.startsWith("/api/") || s.startsWith("/login")) throw new HttpError(400, "That page can't be opened from the app.");
  return s.slice(0, 200);
}

export async function createHandoff(u: SessionUser, next: unknown, base: string): Promise<{ url: string }> {
  const path = safeNext(next);
  const nonce = randomBytes(24).toString("base64url");
  await execute(
    `INSERT INTO handoff_nonces (nonce_hash, user_id, next, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha(nonce), u.id, path, new Date(Date.now() + 60_000).toISOString()]
  );
  await execute(`DELETE FROM handoff_nonces WHERE expires_at < $1`, [new Date(Date.now() - 3_600_000).toISOString()]);
  return { url: `${base.replace(/\/$/, "")}/api/auth/handoff/${nonce}` };
}

/** Consume a hand-off: sets the web session cookie and returns where to go. */
export async function consumeHandoff(nonce: string): Promise<string> {
  const row = await queryOne<{ nonce_hash: string; user_id: string; next: string; expires_at: string; used_at: string | null }>(
    `SELECT * FROM handoff_nonces WHERE nonce_hash = $1`,
    [sha(nonce)]
  );
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return "/login";
  const upd = await execute(
    `UPDATE handoff_nonces SET used_at = $1 WHERE nonce_hash = $2 AND used_at IS NULL`,
    [nowIso(), row.nonce_hash]
  );
  if (upd.rowCount !== 1) return "/login";
  const u = await queryOne<{ id: string; org_id: string; store_id: string | null; username: string; name: string; role: SessionUser["role"]; active: number }>(
    `SELECT id, org_id, store_id, username, name, role, active FROM users WHERE id = $1`,
    [row.user_id]
  );
  if (!u || !u.active) return "/login";
  await setSession({ id: u.id, orgId: u.org_id, storeId: u.store_id, username: u.username, name: u.name, role: u.role, exp: Date.now() + 12 * 3_600_000 });
  return row.next;
}
