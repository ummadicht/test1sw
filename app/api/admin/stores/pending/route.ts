import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { pendingStores } from "@/lib/server/signup";

export async function GET() {
  return handle(async () => ({ stores: pendingStores(await requireUser(["org_admin", "platform"])) }));
}
