import { handle, body } from "@/lib/server/http";
import { joinWithInvite, throttle } from "@/lib/server/signup";

/** Staff sign up with their manager's invite code and are signed in. */
export async function POST(req: Request) {
  return handle(async () => {
    throttle(`join|${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`, 10);
    return joinWithInvite(await body(req));
  });
}
