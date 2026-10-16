import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { reviewStore } from "@/lib/server/signup";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    return reviewStore(u, (await ctx.params).id, await body(req));
  });
}
