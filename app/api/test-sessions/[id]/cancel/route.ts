import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { cancelTestSession } from "@/lib/server/testSessions";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => cancelTestSession(await requireUser(), (await ctx.params).id));
}
