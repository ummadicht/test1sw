import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { createInvite, listInvites } from "@/lib/server/signup";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ({ invites: listInvites(await requireUser(), (await ctx.params).id) }));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    return createInvite(u, (await ctx.params).id, await body(req));
  });
}
