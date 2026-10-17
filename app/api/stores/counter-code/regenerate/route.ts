import { handle, publicOrigin } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { regenerateCounterCode } from "@/lib/server/testSessions";

/** A new counter code for the caller's store → { code, joinUrl }. The old one stops starting new checks. Store manager only. */
export async function POST(req: Request) {
  return handle(async () => regenerateCounterCode(await requireUser(), publicOrigin(req)));
}
