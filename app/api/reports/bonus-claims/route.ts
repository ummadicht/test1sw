import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { bonusClaims } from "@/lib/server/reports";

/** Upgrade-bonus claims. ?orgId= (platform), ?month=YYYY-MM (omit for every month). */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform", "store_manager"]);
    const p = new URL(req.url).searchParams;
    return { rows: bonusClaims(u, { orgId: p.get("orgId"), month: p.get("month") }) };
  });
}
