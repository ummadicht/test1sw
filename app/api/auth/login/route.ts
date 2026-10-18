import { handle, body } from "@/lib/server/http";
import { authenticate, setSession, homeFor, HttpError } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";

// Tiny in-memory throttle: 8 failures per username+IP per 10 minutes.
const fails = new Map<string, { n: number; until: number }>();

export async function POST(req: Request) {
  return handle(async () => {
    await ensureSeeded();
    const b = await body<{ username?: string; password?: string }>(req);
    const key = `${(b.username || "").toLowerCase()}|${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`;
    const f = fails.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, "Too many attempts — wait a few minutes.");
    const u = authenticate(b.username || "", b.password || "");
    if (!u) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60_000 };
      fails.set(key, { n: cur.n + 1, until: cur.until });
      throw new HttpError(401, "Wrong username or password.");
    }
    fails.delete(key);
    await setSession(u);
    return { ok: true, home: homeFor(u.role), user: { name: u.name, role: u.role } };
  });
}
