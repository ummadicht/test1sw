import { handle } from "@/lib/server/http";
import { ensureSeeded } from "@/lib/server/seed";
import { programmes } from "@/lib/server/signup";

/** Programmes a new store can register into from the app. */
export async function GET() {
  return handle(async () => {
    await ensureSeeded();
    return { programmes: programmes() };
  });
}
