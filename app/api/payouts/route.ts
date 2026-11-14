import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import {
  listPayoutRequests,
  createPayoutRequest,
  type CreatePayoutInput,
  type PayoutStatus,
} from "@/lib/server/payouts";

/**
 * GET /api/payouts?storeId=&caseId=&status=
 * - Counter users (`advisor`) receive ONLY customer-facing payout requests (no store balance or ledger fields).
 * - Store Managers (`store_manager`) receive the full approval queue with `storeBalance`, `balanceBefore`, `balanceAfter`, and `ledger`.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager", "org_admin", "platform"]);
    const url = new URL(req.url);
    const storeId = url.searchParams.get("storeId");
    const caseId = url.searchParams.get("caseId");
    const status = url.searchParams.get("status") as PayoutStatus | null;
    return listPayoutRequests(u, { storeId, caseId, status });
  });
}

/**
 * POST /api/payouts
 * Creates a customer trade-in payout request (`PENDING_APPROVAL`) routed to the Store Manager.
 * Supports `X-Payout-Idempotency` / `Idempotency-Key` headers or `idempotencyKey` in the JSON body.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    const b = await body<CreatePayoutInput>(req);
    const headerKey =
      req.headers.get("x-payout-idempotency") ||
      req.headers.get("idempotency-key") ||
      b.idempotencyKey ||
      null;
    const payout = await createPayoutRequest(u, {
      ...b,
      idempotencyKey: headerKey,
    });
    return { payout };
  });
}
