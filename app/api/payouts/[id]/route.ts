import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import {
  getPayoutRequestById,
  approvePayoutRequest,
  rejectPayoutRequest,
} from "@/lib/server/payouts";

/**
 * GET /api/payouts/[id]
 * Returns a single payout request, stripping all store balance fields if the caller is a counter user (`advisor`).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager", "org_admin", "platform"]);
    const { id } = await ctx.params;
    const payout = await getPayoutRequestById(u, id);
    return { payout };
  });
}

/**
 * POST /api/payouts/[id]
 * Store Manager actions:
 * - `{ action: "approve", simulateOutcome?: "processed" | "processing" | "failed" }`
 * - `{ action: "reject", reason: string }`
 * Enforces `store_manager` role and prevents self-approval.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    const b = await body<{
      action?: string;
      reason?: string;
      simulateOutcome?: "processed" | "processing" | "failed";
    }>(req);

    if (b.action === "approve") {
      const payout = await approvePayoutRequest(u, id, {
        simulateOutcome: b.simulateOutcome,
      });
      return { payout };
    }

    if (b.action === "reject") {
      const payout = await rejectPayoutRequest(u, id, b.reason || "");
      return { payout };
    }

    throw new HttpError(400, "Expected action to be 'approve' or 'reject'.");
  });
}
