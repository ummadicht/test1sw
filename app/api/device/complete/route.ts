import { handle } from "@/lib/server/http";
import { deviceComplete } from "@/lib/server/testSessions";

export async function POST(req: Request) {
  return handle(async () => deviceComplete(req.headers.get("authorization")));
}
