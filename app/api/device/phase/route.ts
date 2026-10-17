import { handle, body } from "@/lib/server/http";
import { devicePhase } from "@/lib/server/testSessions";

/**
 * SwapUp Check ≥ 0.6.0 says which step it is on (Authorization: Ticket …):
 * { phase: "identify" | "scan" | "battery" | "test" | "done" } → { ok }. Only
 * the store's screen reads it (TestSessionView.phonePhase, the camera card's line).
 */
export async function POST(req: Request) {
  return handle(async () => devicePhase(req.headers.get("authorization"), await body<{ phase?: unknown }>(req)));
}
