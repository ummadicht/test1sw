import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { rateCardDetail, activateRateCard } from "@/lib/server/catalog";
import { partnerMode } from "@/lib/server/buyback";
import { ratecardPartnerId, tradeModelNames } from "@/lib/server/ratecard-extra";

/** One card in full: its entries and deductions, plus readable phone names for the entries. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["partner", "platform"]);
    const { id } = await ctx.params;
    const partnerId = ratecardPartnerId(u, new URL(req.url).searchParams.get("partnerId"));
    return { card: rateCardDetail(partnerId, id), modelNames: tradeModelNames() };
  });
}

/** {action: "activate"} — make this card the one every new quote is priced from. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["partner", "platform"]);
    const { id } = await ctx.params;
    const b = await body<{ action?: string; partnerId?: string }>(req);
    if (b.action !== "activate") throw new HttpError(400, "Action must be activate.");
    const partnerId = ratecardPartnerId(u, b.partnerId ?? new URL(req.url).searchParams.get("partnerId"));
    return { cards: activateRateCard(u, id, partnerId), mode: partnerMode(partnerId) };
  });
}
