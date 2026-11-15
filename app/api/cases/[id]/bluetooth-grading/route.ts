import { handle, body, publicOrigin } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import {
  runBluetoothGradingTest,
  type BluetoothGradingInput,
} from "@/lib/server/bluetoothGrading";

/**
 * POST /api/cases/[id]/bluetooth-grading
 * Connects a Bluetooth / BLE diagnostic session to case `[id]` (or creates a new case when `id === "new"`),
 * records the 19-point hardware test results + GATT battery health + cosmetic checks,
 * and computes & issues the official SwapUp Grade Report (Grade A / B / C / D).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    const { id } = await ctx.params;
    const b = await body<BluetoothGradingInput>(req);
    return runBluetoothGradingTest(
      u,
      {
        ...b,
        caseId: id === "new" ? null : id,
      },
      publicOrigin(req)
    );
  });
}
