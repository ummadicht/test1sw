import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { rateCards, uploadRateCard } from "@/lib/server/catalog";
import { partnerMode } from "@/lib/server/buyback";
import { ratecardPartnerId, readDeductions } from "@/lib/server/ratecard-extra";

/** The partner's rate cards and which pricing mode is in force. Platform passes ?partnerId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["partner", "platform"]);
    const partnerId = await ratecardPartnerId(u, new URL(req.url).searchParams.get("partnerId"));
    return { cards: await rateCards(partnerId), mode: await partnerMode(partnerId) };
  });
}

/**
 * Upload a sheet: CSV `model_id,variant,max_price`. Condition deductions carry
 * over from the active card unless `deductions` (basis points) are sent — the
 * partner's FIRST card must send them.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["partner", "platform"]);
    const b = await body<{ partnerId?: string; label?: string; effectiveFrom?: string; quoteValidityDays?: unknown; csv?: string; activate?: boolean; deductions?: unknown }>(req);
    const partnerId = await ratecardPartnerId(u, b.partnerId ?? new URL(req.url).searchParams.get("partnerId"));
    const cards = await uploadRateCard(u, {
      partnerId,
      label: String(b.label ?? ""),
      effectiveFrom: String(b.effectiveFrom ?? ""),
      quoteValidityDays: Number(b.quoteValidityDays),
      csv: String(b.csv ?? ""),
      deductions: b.deductions === undefined || b.deductions === null ? undefined : readDeductions(b.deductions),
      activate: b.activate !== false,
    });
    return { cards, mode: await partnerMode(partnerId) };
  });
}
