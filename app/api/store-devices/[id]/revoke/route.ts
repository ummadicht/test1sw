import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { revokeStoreDevice } from "@/lib/server/storeTablet";

/** Remove a store tablet (lost, replaced): its device token stops working at once. Idempotent. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    return revokeStoreDevice(u, (await ctx.params).id);
  });
}
