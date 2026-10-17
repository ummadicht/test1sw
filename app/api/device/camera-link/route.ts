import { handle } from "@/lib/server/http";
import { deviceCameraLinkGet } from "@/lib/server/testSessions";

/**
 * The Scan screen's QR on SwapUp Check ≥ 0.6.0 (Authorization: Ticket …) →
 * { url }: GradeIQ's own camera link for this check, the full single pass —
 * GradeIQ v2's way, by the owner's decision (docs/PHONE-LED-FLOW.md). 409 until
 * GradeIQ has a session for it; the phone asks again.
 */
export async function GET(req: Request) {
  return handle(async () => deviceCameraLinkGet(req.headers.get("authorization")));
}
