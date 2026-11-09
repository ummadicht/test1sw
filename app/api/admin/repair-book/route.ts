import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { repairBook, saveRepairPrice } from "@/lib/server/catalog";
import { adminOrgId } from "@/lib/server/scope";

/** The programme's repair price book. ?modelId= narrows to one model; platform passes ?orgId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const p = new URL(req.url).searchParams;
    const orgId = await adminOrgId(u, p.get("orgId"));
    return { rows: await repairBook(orgId, p.get("modelId")) };
  });
}

/** Set (or, with price null, remove) one part price: { orgId?, modelId, part, price, sourceLabel? }. Returns that model's rows. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<{ orgId?: string; modelId?: string; part?: string; price?: unknown; sourceLabel?: string }>(req);
    const price = b.price === null ? null : typeof b.price === "number" ? b.price : Number.NaN;
    const rows = await saveRepairPrice(u, {
      orgId: b.orgId,
      modelId: String(b.modelId ?? ""),
      part: String(b.part ?? ""),
      price,
      sourceLabel: b.sourceLabel ? String(b.sourceLabel) : undefined,
    });
    return { rows };
  });
}
