import { handle, body } from "@/lib/server/http";
import { deviceDeclare } from "@/lib/server/testSessions";

export async function POST(req: Request) {
  return handle(async () => deviceDeclare(req.headers.get("authorization"), await body(req)));
}
