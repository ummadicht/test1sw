import { handle, body } from "@/lib/server/http";
import { requireUser, orgSettings, type OrgSettings } from "@/lib/server/auth";
import { updateOrgSettings } from "@/lib/server/admin";
import { adminOrgId } from "@/lib/server/scope";

/** Programme settings. Platform passes ?orgId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const orgId = await adminOrgId(u, new URL(req.url).searchParams.get("orgId"));
    return { settings: await orgSettings(orgId) };
  });
}

/** Update programme settings: { orgId?, patch }. The bonus band is platform-only (the service refuses it otherwise). */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<{ orgId?: string; patch?: Partial<OrgSettings> }>(req);
    const org = await updateOrgSettings(u, b.orgId ?? null, b.patch && typeof b.patch === "object" ? b.patch : {});
    return { settings: org.settings };
  });
}
