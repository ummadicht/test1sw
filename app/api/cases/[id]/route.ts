import { handle, body } from "@/lib/server/http";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import { requireUser, HttpError } from "@/lib/server/auth";
import { updateCase, type CasePatch } from "@/lib/server/cases";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    return getCaseForViewer(u, id);
  });
}

/** Save what the advisor learned about the phone; the case re-prices and comes back whole. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    const { id } = await ctx.params;
    const patch = await body<CasePatch>(req);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Expected the changes as a JSON object.");
    return updateCase(u, id, patch);
  });
}
