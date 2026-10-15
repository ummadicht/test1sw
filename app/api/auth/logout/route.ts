import { handle } from "@/lib/server/http";
import { clearSession } from "@/lib/server/auth";

export async function POST() {
  return handle(async () => {
    await clearSession();
    return { ok: true };
  });
}
