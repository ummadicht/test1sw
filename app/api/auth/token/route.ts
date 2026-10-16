import { handle, body } from "@/lib/server/http";
import { HttpError } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";
import { tokenLogin } from "@/lib/server/mobileAuth";

// Same throttle as the web login: 8 failures per username+IP per 10 minutes.
const fails = new Map<string, { n: number; until: number }>();

/** Store app sign-in → Bearer token (counter staff only). */
export async function POST(req: Request) {
  return handle(async () => {
    await ensureSeeded();
    const b = await body<{ username?: string; password?: string }>(req);
    const key = `${(b.username || "").toLowerCase()}|${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`;
    const f = fails.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
    const r = tokenLogin(b.username || "", b.password || "");
    if (!r) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60_000 };
      fails.set(key, { n: cur.n + 1, until: cur.until });
      throw new HttpError(401, "Wrong username or password.");
    }
    fails.delete(key);
    return r;
  });
}
