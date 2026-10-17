import { handle, body } from "@/lib/server/http";
import { requireDevice, tabletUnlock } from "@/lib/server/storeTablet";

/** { userId, pin } → the same staff token as /api/auth/token. Authorization: Device <token>. */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = requireDevice(req);
    return tabletUnlock(ctx, await body<{ userId?: unknown; pin?: unknown }>(req));
  });
}
