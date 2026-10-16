import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getTestSession } from "@/lib/server/testSessions";

/** The store app polls this every 2 s; it also drives the (throttled) GradeIQ pulls. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => (await getTestSession(await requireUser(), (await ctx.params).id)).session);
}
