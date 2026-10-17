import { handle, body } from "@/lib/server/http";
import { deviceBattery } from "@/lib/server/testSessions";

/**
 * The battery-health screenshot (Authorization: Ticket …): { image: data URL,
 * ≤ 3 MB } → { healthPct | null, outcome }. GradeIQ reads the %; the server
 * records battery_health (below 80 % is the battery_drain fault).
 */
export async function POST(req: Request) {
  return handle(async () => deviceBattery(req.headers.get("authorization"), await body<{ image?: unknown }>(req)));
}
