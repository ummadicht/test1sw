import { handle } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { creditSummary } from "@/lib/server/credit";
import { audit } from "@/lib/server/db";

/** A store's credit line & available balance. Only Store Managers (and admins) may view balance figures. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    if (u.role === "advisor" || !["store_manager", "org_admin", "platform"].includes(u.role)) {
      await audit({
        userId: u.id,
        orgId: u.orgId,
        storeId: u.storeId,
        action: "credit.access_denied",
        entity: "store",
        entityId: id,
        detail: { userId: u.id, role: u.role, reason: "Store counter login may not view store balance" },
      });
      throw new HttpError(403, "Store counter users are not permitted to view store balance or wallet figures.");
    }
    const ledger = new URL(req.url).searchParams.get("ledger") === "1";
    return creditSummary(u, id, { withLedger: ledger });
  });
}
