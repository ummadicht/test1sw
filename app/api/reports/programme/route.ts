import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { programmeReport } from "@/lib/server/reports";

/** Programme report per store + totals. ?orgId= (platform), ?from=&to= (YYYY-MM-DD, by case opened date). */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform", "store_manager"]);
    const p = new URL(req.url).searchParams;
    const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return programmeReport(u, { orgId: p.get("orgId"), from: day(p.get("from")), to: day(p.get("to")) });
  });
}
