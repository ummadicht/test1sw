import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { newDevices } from "@/lib/server/catalog";
import { adminOrgId } from "@/lib/server/scope";

/** The new phones this client's customers can upgrade into. Admins may pass ?all=1 (and platform ?orgId=). */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    const url = new URL(req.url);
    const all = url.searchParams.get("all") === "1";
    if (all) {
      const orgId = await adminOrgId(u, url.searchParams.get("orgId"));
      return { devices: await newDevices(orgId, true) };
    }
    if (u.role === "partner") return { devices: [] };
    const orgId = u.role === "platform" ? await adminOrgId(u, url.searchParams.get("orgId")) : u.orgId;
    return { devices: await newDevices(orgId) };
  });
}
