import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { changeOwnPassword } from "@/lib/server/admin";

/** Change your own password. A wrong current password is a 400, not a 401 — it must not sign you out. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    const b = await body<{ current?: string; next?: string }>(req);
    changeOwnPassword(u, String(b.current ?? ""), String(b.next ?? ""));
    return { ok: true };
  });
}
