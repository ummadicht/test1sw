import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import {
  reprice,
  chooseRepair,
  walkAway,
  lockTradeIn,
  cancelTradeIn,
  recordDataClear,
  setBonusOverride,
  type CaseView,
  type LockInput,
} from "@/lib/server/cases";

type ActionBody = {
  action?: unknown;
  requote?: unknown;
  reason?: unknown;
  customer?: LockInput["customer"];
  checks?: LockInput["checks"];
  bp?: unknown;
  steps?: Record<string, unknown>;
  note?: unknown;
};

/**
 * The lifecycle throws a plain Error for an impossible move ("a case that is
 * Chose repair cannot become Traded in"). That is the caller asking for
 * something the case's state forbids — a 409 with that sentence, not a 500.
 */
async function transition(fn: () => CaseView | Promise<CaseView>): Promise<CaseView> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof HttpError) && e instanceof Error && e.message.includes("cannot become")) throw new HttpError(409, e.message);
    throw e;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One door for every case action: reprice, choose_repair, walk_away, lock, cancel, data_clear, bonus_override. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    const b = await body<ActionBody>(req);
    switch (b.action) {
      case "reprice":
        if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff re-price a case.");
        return reprice(u, id, { requote: b.requote === true });
      case "choose_repair":
        return transition(() => chooseRepair(u, id));
      case "walk_away":
        return transition(() => walkAway(u, id, str(b.reason)?.trim() || undefined));
      case "lock":
        if (!b.customer || !b.checks) throw new HttpError(400, "Send the customer and the hand-over checks.");
        return transition(() => lockTradeIn(u, id, { customer: b.customer!, checks: b.checks! }));
      case "cancel":
        return transition(() => cancelTradeIn(u, id, str(b.reason) ?? ""));
      case "data_clear":
        return recordDataClear(u, id, { ...(b.steps ?? {}), note: b.note });
      case "bonus_override": {
        if (b.bp !== null && typeof b.bp !== "number") throw new HttpError(400, "Send the bonus in basis points, or null to reset it.");
        return setBonusOverride(u, id, { bp: b.bp, reason: str(b.reason) });
      }
      default:
        throw new HttpError(400, `Unknown action${typeof b.action === "string" ? `: ${b.action}` : ""}.`);
    }
  });
}
