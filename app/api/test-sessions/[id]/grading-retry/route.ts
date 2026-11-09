import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { retryGrading } from "@/lib/server/testSessions";

/** "Camera grading unavailable" → Retry: a fresh GradeIQ session for this test session. → TestSessionView */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => (await retryGrading(await requireUser(), (await ctx.params).id)).session);
}
