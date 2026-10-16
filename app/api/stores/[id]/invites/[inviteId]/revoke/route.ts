import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { revokeInvite } from "@/lib/server/signup";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; inviteId: string }> }) {
  return handle(async () => {
    const { id, inviteId } = await ctx.params;
    return revokeInvite(await requireUser(), id, inviteId);
  });
}
