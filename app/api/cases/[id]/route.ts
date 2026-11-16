import { handle, body } from "@/lib/server/http";
import {
  getCaseForViewer,
  redactCaseForCounter,
  prepareCounterCasePatch,
  ensureCounterCaseSwappable,
} from "@/lib/server/counter-extra";
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
    const rawPatch = await body<CasePatch>(req);
    if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch))
      throw new HttpError(400, "Expected the changes as a JSON object.");
    const patch = await prepareCounterCasePatch(id, rawPatch);
    let updated = await updateCase(u, id, patch);
    updated = await ensureCounterCaseSwappable(u, id, updated, rawPatch.upgradeDeviceId !== undefined);
    return redactCaseForCounter(u, updated);
  });
}
