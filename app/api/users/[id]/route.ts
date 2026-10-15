import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { resetPassword, setUserActive } from "@/lib/server/admin";

/** {action: "reset"} → a new one-time password; {action: "activate"|"deactivate"} → the caller's user list. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["platform", "org_admin", "store_manager", "partner"]);
    const { id } = await ctx.params;
    const b = await body<{ action?: string }>(req);
    switch (b.action) {
      case "reset":
        return resetPassword(u, id);
      case "activate":
        return { users: setUserActive(u, id, true) };
      case "deactivate":
        return { users: setUserActive(u, id, false) };
      default:
        throw new HttpError(400, "Action must be reset, activate or deactivate.");
    }
  });
}
