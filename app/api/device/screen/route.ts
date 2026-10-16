import { handle, body } from "@/lib/server/http";
import { deviceScreenGet, deviceScreenPost } from "@/lib/server/testSessions";

/**
 * The photo check on the customer's phone (Authorization: Ticket …). GET: the
 * pattern the store's camera wants shown. POST { shown }: the pattern the
 * phone is actually showing. Proxied to GradeIQ; its session id never leaves
 * the server.
 */
export async function GET(req: Request) {
  return handle(async () => deviceScreenGet(req.headers.get("authorization")));
}

export async function POST(req: Request) {
  return handle(async () => deviceScreenPost(req.headers.get("authorization"), await body<{ shown?: unknown }>(req)));
}
