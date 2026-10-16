import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { createTestSession, listOpenSessions } from "@/lib/server/testSessions";

export async function GET() {
  return handle(async () => ({ sessions: listOpenSessions(await requireUser()) }));
}

export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    const b = await body<{ caseId?: string; customerName?: string; customerPhone?: string }>(req);
    return createTestSession(u, b);
  });
}
