import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { ratecardPartnerId, rateCardTemplateCsv } from "@/lib/server/ratecard-extra";

/**
 * The upload template as a CSV download: every catalogue model × storage,
 * prices filled in from the partner's own active card (blank without one).
 */
export async function GET(req: Request) {
  try {
    const u = await requireUser(["partner", "platform"]);
    const partnerId = ratecardPartnerId(u, new URL(req.url).searchParams.get("partnerId"));
    const t = rateCardTemplateCsv(partnerId);
    return new Response(t.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${t.filename}"`,
        "cache-control": "no-store",
        "x-swapup-rows": String(t.rows),
        "x-swapup-prefilled": String(t.prefilled),
      },
    });
  } catch (e) {
    // Same status + message mapping as every other route.
    return handle(() => {
      throw e;
    });
  }
}
