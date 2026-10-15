import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { listPickups, requestPickup } from "@/lib/server/pickups";
import { PICKUP_STATUS_LABEL, type PickupStatus } from "@/lib/domain/lifecycle";

const PICKUP_STATUSES = Object.keys(PICKUP_STATUS_LABEL) as PickupStatus[];

/** Pickups in the caller's scope. ?status=requested,scheduled&storeId= narrow it. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["store_manager", "partner", "org_admin", "platform"]);
    const sp = new URL(req.url).searchParams;
    const raw = (sp.get("status") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = raw.filter((s) => !(PICKUP_STATUSES as string[]).includes(s));
    if (bad.length) throw new HttpError(400, `Unknown pickup status: ${bad.join(", ")}.`);
    return { pickups: listPickups(u, { status: raw.length ? (raw as PickupStatus[]) : null, storeId: sp.get("storeId") || null }) };
  });
}

/** The store manager asks the partner to collect. With no caseIds, every phone waiting at the store goes on it. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["store_manager"]);
    const b = await body<{ caseIds?: unknown; notes?: unknown }>(req);
    const caseIds = Array.isArray(b.caseIds) ? b.caseIds.map((x) => String(x)) : null;
    const notes = typeof b.notes === "string" ? b.notes : null;
    return requestPickup(u, { caseIds, notes });
  });
}
