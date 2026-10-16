import { handle, body } from "@/lib/server/http";
import { deviceResults } from "@/lib/server/testSessions";

export async function POST(req: Request) {
  return handle(async () => deviceResults(req.headers.get("authorization"), await body<{ results?: unknown }>(req)));
}
