import { handle, publicOrigin } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getCounterCode } from "@/lib/server/testSessions";

/** The caller's store's permanent counter code → { code, joinUrl } (made on first read). Advisor or store manager. */
export async function GET(req: Request) {
  return handle(async () => getCounterCode(await requireUser(), publicOrigin(req)));
}
