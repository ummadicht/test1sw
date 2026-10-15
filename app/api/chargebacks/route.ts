import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { openChargebacks } from "@/lib/server/pickups";

/** Shortfalls still open against store credit lines, in the caller's scope. ?storeId= narrows to one store. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["store_manager", "partner", "org_admin", "platform"]);
    const storeId = new URL(req.url).searchParams.get("storeId") || null;
    return { chargebacks: openChargebacks(u, storeId) };
  });
}
