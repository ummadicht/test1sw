import { handle, body } from "@/lib/server/http";
import { requireDevice, tabletSetPin } from "@/lib/server/storeTablet";

/** { userId, password, pin } → sets the person's PIN and signs them in. Authorization: Device <token>. */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = await requireDevice(req);
    return tabletSetPin(ctx, await body<{ userId?: unknown; password?: unknown; pin?: unknown }>(req));
  });
}
