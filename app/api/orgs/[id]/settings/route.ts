import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError, type OrgSettings } from "@/lib/server/auth";
import { updateOrgSettings } from "@/lib/server/admin";

/**
 * Change a client's programme band (the 2–5% upgrade-bonus promise).
 * Only the band travels through this route; the rest of a programme's settings
 * belong to the programme's own settings screen.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["platform"]);
    const { id } = await ctx.params;
    const b = await body<{ bandMinBp?: unknown; bandMaxBp?: unknown }>(req);
    const patch: Partial<OrgSettings> = {};
    if (b.bandMinBp !== undefined) patch.bandMinBp = Number(b.bandMinBp);
    if (b.bandMaxBp !== undefined) patch.bandMaxBp = Number(b.bandMaxBp);
    if (!Object.keys(patch).length) throw new HttpError(400, "Send bandMinBp and/or bandMaxBp.");
    return { org: updateOrgSettings(u, id, patch) };
  });
}
