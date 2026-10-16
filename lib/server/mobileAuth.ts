import { createHash, randomBytes } from "node:crypto";
import { db, nowIso } from "./db";
import { HttpError, authenticate, issueToken, setSession, ROLE_LABEL, type SessionUser } from "./auth";
import { getOrg, getStore } from "./scope";

/**
 * The store app signs in with the same accounts as the web desk and gets the
 * same signed session as a Bearer token. Only counter staff — the app is a
 * counter tool. To continue a case on the web desk inside the app's WebView, it
 * asks for a one-time hand-off URL (60 s, single use) that sets the web cookie.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function userPayload(u: SessionUser) {
  const org = getOrg(u.orgId);
  const store = u.storeId ? getStore(u.storeId) : null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    org: org ? { id: org.id, name: org.name, demo: !!org.demo } : null,
    store: store ? { id: store.id, name: store.name, code: store.code, city: store.city, kind: store.kind } : null,
  };
}

export function tokenLogin(username: string, password: string) {
  const u = authenticate(username, password);
  if (!u) return null;
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "The store app is for store staff. Use the web console for your role.");
  return { token: issueToken(u), expiresAt: new Date(u.exp).toISOString(), user: userPayload(u) };
}

/** Only same-site paths into the counter: never an absolute URL, never back into auth. */
function safeNext(n: unknown): string {
  const s = typeof n === "string" ? n : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.startsWith("/api/") || s.startsWith("/login")) throw new HttpError(400, "That page can't be opened from the app.");
  return s.slice(0, 200);
}

export function createHandoff(u: SessionUser, next: unknown, base: string): { url: string } {
  const path = safeNext(next);
  const nonce = randomBytes(24).toString("base64url");
  db()
    .prepare(`INSERT INTO handoff_nonces (nonce_hash, user_id, next, expires_at) VALUES (?,?,?,?)`)
    .run(sha(nonce), u.id, path, new Date(Date.now() + 60_000).toISOString());
  db().prepare(`DELETE FROM handoff_nonces WHERE expires_at < ?`).run(new Date(Date.now() - 3_600_000).toISOString());
  return { url: `${base.replace(/\/$/, "")}/api/auth/handoff/${nonce}` };
}

/** Consume a hand-off: sets the web session cookie and returns where to go. */
export async function consumeHandoff(nonce: string): Promise<string> {
  const row = db().prepare(`SELECT * FROM handoff_nonces WHERE nonce_hash = ?`).get(sha(nonce)) as
    | { nonce_hash: string; user_id: string; next: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return "/login";
  const upd = db().prepare(`UPDATE handoff_nonces SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL`).run(nowIso(), row.nonce_hash);
  if (upd.changes !== 1) return "/login";
  const u = db().prepare(`SELECT id, org_id, store_id, username, name, role, active FROM users WHERE id = ?`).get(row.user_id) as
    | { id: string; org_id: string; store_id: string | null; username: string; name: string; role: SessionUser["role"]; active: number }
    | undefined;
  if (!u || !u.active) return "/login";
  await setSession({ id: u.id, orgId: u.org_id, storeId: u.store_id, username: u.username, name: u.name, role: u.role, exp: Date.now() + 12 * 3_600_000 });
  return row.next;
}
