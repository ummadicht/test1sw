import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { createStoreDevice, listStoreDevices } from "@/lib/server/storeTablet";

/** The store's tablets: a store manager sees their own store; a programme admin passes ?storeId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    return { devices: listStoreDevices(u, new URL(req.url).searchParams.get("storeId")) };
  });
}

/** Make this device the store's tablet: { name } → 201 with the device token (shown once). Store manager only. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    return createStoreDevice(u, await body<{ name?: unknown }>(req));
  }, 201);
}
