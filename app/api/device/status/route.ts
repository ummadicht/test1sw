import { handle } from "@/lib/server/http";
import { deviceStatus } from "@/lib/server/testSessions";

export async function GET(req: Request) {
  return handle(async () => deviceStatus(req.headers.get("authorization")));
}
