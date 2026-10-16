import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { applyTestSession } from "@/lib/server/testSessions";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => applyTestSession(await requireUser(), (await ctx.params).id));
}
