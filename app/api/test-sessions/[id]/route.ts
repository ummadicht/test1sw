import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getTestSession } from "@/lib/server/testSessions";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => getTestSession(await requireUser(), (await ctx.params).id).session);
}
