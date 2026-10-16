import { handle, body, publicOrigin } from "@/lib/server/http";
import { ensureSeeded } from "@/lib/server/seed";
import { joinByCode } from "@/lib/server/testSessions";

/** The customer's phone exchanges the 6-character code for a ticket. */
export async function POST(req: Request) {
  return handle(async () => {
    await ensureSeeded();
    const b = await body<{ code?: string; device?: unknown; appVersion?: string; installId?: string }>(req);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    return joinByCode(b, ip, publicOrigin(req));
  });
}
