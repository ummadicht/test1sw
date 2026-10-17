import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { setOwnPin } from "@/lib/server/storeTablet";

/** Set or change your own tablet PIN: { password, pin }. Advisors and store managers. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    return setOwnPin(u, await body<{ password?: unknown; pin?: unknown }>(req));
  });
}
