import { handle } from "@/lib/server/http";
import { invitePreview, throttle } from "@/lib/server/signup";

/** Which store an invite code is for — shown before the person signs up. */
export async function GET(req: Request) {
  return handle(async () => {
    throttle(`peek|${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`, 30);
    return invitePreview(new URL(req.url).searchParams.get("code"));
  });
}
