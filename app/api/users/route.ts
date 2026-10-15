import { handle, body } from "@/lib/server/http";
import { requireUser, type Role } from "@/lib/server/auth";
import { listUsers, createUser } from "@/lib/server/admin";

const MANAGERS: Role[] = ["platform", "org_admin", "store_manager", "partner"];

/** The people this caller may see (platform: everyone; org admin / partner: their org; store manager: their store). */
export async function GET() {
  return handle(async () => {
    const u = await requireUser(MANAGERS);
    return { users: listUsers(u) };
  });
}

/** Add a person. The temporary password is returned ONCE, here, and never stored in clear. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(MANAGERS);
    const b = await body<{ name?: string; username?: string; role?: Role; orgId?: string | null; storeId?: string | null }>(req);
    return createUser(u, {
      name: String(b.name ?? ""),
      username: String(b.username ?? ""),
      role: b.role as Role,
      orgId: b.orgId ?? null,
      storeId: b.storeId ?? null,
    });
  });
}
