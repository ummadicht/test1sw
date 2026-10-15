import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getPickup } from "@/lib/server/pickups";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["store_manager", "partner", "org_admin", "platform"]);
    const { id } = await ctx.params;
    return getPickup(u, id);
  });
}
