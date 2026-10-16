import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getStoreWifi, setStoreWifi } from "@/lib/server/testSessions";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => getStoreWifi(await requireUser(), (await ctx.params).id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    return setStoreWifi(u, (await ctx.params).id, await body(req));
  });
}
