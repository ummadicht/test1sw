import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { getStorePhonecheck, setStorePhonecheck } from "@/lib/server/phonecheck";

/** The store's Phonecheck station login → { station, serverDefault, configured: {ok, why} }. Not for the partner. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => getStorePhonecheck(await requireUser(), (await ctx.params).id));
}

/** { station: "Teja-D04" | null } — store manager (own store), programme admin. Same shape as /wifi. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    return setStorePhonecheck(u, (await ctx.params).id, await body(req));
  });
}

/** POST is the same as PUT — /wifi takes POST, so a client written for it works here too. */
export const POST = PUT;
