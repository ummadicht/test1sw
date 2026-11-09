import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { newDevices } from "@/lib/server/catalog";
import { adminOrgId } from "@/lib/server/scope";
import { setNewDeviceActive } from "@/lib/server/admin-extra";

/** Show or hide a new phone at the counter, keeping its price and price source: { orgId?, active }. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const { id } = await ctx.params;
    const b = await body<{ orgId?: string; active?: unknown }>(req);
    const orgId = await adminOrgId(u, b.orgId);
    await setNewDeviceActive(u, { orgId, id, active: b.active === true });
    return { devices: await newDevices(orgId, true) };
  });
}
