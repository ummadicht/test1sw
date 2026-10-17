import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { findCustomer } from "@/lib/server/customers";

/**
 * A returning customer, found by mobile number — the counter's first step.
 * ?phone=<10 digits> → { customer: { name, phone } | null, history: [...] }
 * (newest first, at most 10). Counter staff only; their own organisation's cases.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    return findCustomer(u, new URL(req.url).searchParams.get("phone"));
  });
}
