import { handle, publicOrigin } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { releaseScan } from "@/lib/server/testSessions";

/**
 * Let the customer's phone go on from its Scan step without the camera — by the
 * signed-in staff member's name (advisor or store manager). The customer is
 * never offered a skip; GET /api/device/screen says `released: true` and the
 * phone runs its tests. The screen is then certified by eye on "Check the
 * phone". No body. → TestSessionView
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    return (await releaseScan(u, (await ctx.params).id, publicOrigin(req))).session;
  });
}
