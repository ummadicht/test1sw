import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { createHandoff } from "@/lib/server/mobileAuth";

/** One-time URL that signs the app's WebView into the web desk at `next`. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    const b = await body<{ next?: string }>(req);
    const base = process.env.SWAPUP_PUBLIC_URL || new URL(req.url).origin;
    return createHandoff(u, b.next, base);
  });
}
