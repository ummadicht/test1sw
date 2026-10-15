import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { creditSummary } from "@/lib/server/credit";

/** A store's credit line. ?ledger=1 adds the ledger for managers (advisors never get it). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    const ledger = new URL(req.url).searchParams.get("ledger") === "1";
    return creditSummary(u, id, { withLedger: ledger });
  });
}
