import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { setCreditLimit } from "@/lib/server/credit";

/** Change a store's trade-in credit limit: { limit, reason }. Audited with the old and new values. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const { id } = await ctx.params;
    const b = await body<{ limit?: unknown; reason?: unknown }>(req);
    // A missing limit must not silently become ₹0 (which would stop the store trading in).
    const limit = typeof b.limit === "number" ? b.limit : Number.NaN;
    const store = setCreditLimit(u, id, limit, String(b.reason ?? ""));
    return { store };
  });
}
