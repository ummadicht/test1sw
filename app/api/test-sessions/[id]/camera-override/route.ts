import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { cameraOverride } from "@/lib/server/testSessions";

/**
 * Unlock GradeIQ's camera page without the customer's phone echoing patterns.
 * { reason } — recorded with the staff member's name. A screen sweep that then
 * runs to the end still counts (its frames prove the phone showed each colour);
 * if none runs, the LCD is recorded as not camera-checked, and the advisor
 * certifies the screen by eye. → TestSessionView
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const b = await body<{ reason?: string }>(req);
    return (await cameraOverride(u, (await ctx.params).id, b)).session;
  });
}
