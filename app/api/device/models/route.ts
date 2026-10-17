import { handle } from "@/lib/server/http";
import { deviceModels } from "@/lib/server/testSessions";

/**
 * The model picker on the customer's phone (Authorization: Ticket …), for a
 * phone SwapUp could not recognise: no ?brand= → { brands }; ?brand=Samsung →
 * { models: [{ id, brand, model, variants }] }. SwapUp's own list, no prices.
 */
export async function GET(req: Request) {
  return handle(async () => deviceModels(req.headers.get("authorization"), new URL(req.url).searchParams.get("brand")));
}
