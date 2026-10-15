import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import {
  schedulePickup,
  collectPickup,
  clearItem,
  settlePickup,
  cancelPickup,
  removeFromPickup,
} from "@/lib/server/pickups";
import type { ClearanceOutcome } from "@/lib/domain/lifecycle";

type ActionBody = {
  action?: unknown;
  scheduledFor?: unknown;
  collectorName?: unknown;
  collectedCaseIds?: unknown;
  handoverBy?: unknown;
  caseId?: unknown;
  outcome?: unknown;
  accepted?: unknown;
  reason?: unknown;
  reference?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/**
 * One endpoint for every step of a pickup. The services decide who may do
 * what and when; this only shapes the body.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["store_manager", "partner", "org_admin", "platform"]);
    const { id } = await ctx.params;
    const b = await body<ActionBody>(req);
    switch (b.action) {
      case "schedule":
        return schedulePickup(u, id, { scheduledFor: str(b.scheduledFor), collectorName: str(b.collectorName) });
      case "collect":
        return collectPickup(u, id, {
          collectedCaseIds: Array.isArray(b.collectedCaseIds) ? b.collectedCaseIds.map((x) => String(x)) : [],
          collectorName: str(b.collectorName),
          handoverBy: str(b.handoverBy),
        });
      case "clear":
        // Amount and regrade rules are RuleErrors from lib/domain/lifecycle — handle() answers them as 400.
        return clearItem(u, id, {
          caseId: str(b.caseId),
          outcome: str(b.outcome) as ClearanceOutcome,
          accepted: b.accepted === undefined || b.accepted === null || b.accepted === "" ? undefined : Number(b.accepted),
          reason: str(b.reason),
        });
      case "settle":
        return settlePickup(u, id, { reference: str(b.reference) });
      case "cancel":
        return cancelPickup(u, id);
      case "remove":
        return removeFromPickup(u, id, str(b.caseId));
      default:
        throw new HttpError(400, "Unknown pickup action.");
    }
  });
}
