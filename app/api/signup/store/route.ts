import { handle, body } from "@/lib/server/http";
import { ensureSeeded } from "@/lib/server/seed";
import { registerStore, throttle } from "@/lib/server/signup";

/** A store registers itself (pending approval) and its manager is signed in. */
export async function POST(req: Request) {
  return handle(async () => {
    await ensureSeeded();
    throttle(`reg|${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`, 5, 60 * 60_000);
    return registerStore(await body(req));
  });
}
