import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { listOrgs, createOrg } from "@/lib/server/admin";

/** Clients and partners. Platform sees every org; anyone else sees only their own. */
export async function GET() {
  return handle(async () => {
    const u = await requireUser();
    return { orgs: listOrgs(u) };
  });
}

/** Onboard a client or a buyback partner (platform only — the service enforces it). */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["platform"]);
    const b = await body<{ name?: string; kind?: string; clientType?: string; targetBrand?: string; partnerId?: string | null }>(req);
    const org = createOrg(u, {
      name: String(b.name ?? ""),
      kind: b.kind as "client" | "partner", // the service rejects anything else with a readable message
      clientType: b.clientType,
      targetBrand: b.targetBrand,
      partnerId: b.partnerId ?? null,
    });
    return { org };
  });
}
