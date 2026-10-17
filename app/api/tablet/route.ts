import { handle } from "@/lib/server/http";
import { requireDevice, tabletInfo } from "@/lib/server/storeTablet";

/** "Who's serving?" — the tablet's store and its counter staff. Authorization: Device <token>. */
export async function GET(req: Request) {
  return handle(() => tabletInfo(requireDevice(req)));
}
