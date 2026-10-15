import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { recoverChargeback } from "@/lib/server/pickups";

/** Close (part of) an open shortfall. The service decides who may and caps it at what is open. */
export async function POST(req: Request, ctx: { params: Promise<{ caseId: string }> }) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform", "partner"]);
    const { caseId } = await ctx.params;
    const b = await body<{ amount?: unknown; note?: unknown }>(req);
    return recoverChargeback(u, caseId, {
      amount: Number(b.amount),
      note: typeof b.note === "string" ? b.note : "",
    });
  });
}
