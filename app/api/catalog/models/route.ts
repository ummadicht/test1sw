import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { tradeModels, tradeBrands } from "@/lib/server/catalog";

/** Trade-in models (any brand). ?q= searches brand+model, ?brand= filters. */
export async function GET(req: Request) {
  return handle(async () => {
    await requireUser();
    const url = new URL(req.url);
    return { brands: tradeBrands(), models: tradeModels(url.searchParams.get("q"), url.searchParams.get("brand")) };
  });
}
