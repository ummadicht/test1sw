import { handle, publicOrigin } from "@/lib/server/http";
import { clearSession, getKeycloakIdTokenCookie } from "@/lib/server/auth";
import { buildKeycloakLogoutUrl } from "@/lib/server/keycloak";

export async function POST(req: Request) {
  return handle(async () => {
    const idTokenHint = await getKeycloakIdTokenCookie();
    const origin = publicOrigin(req);
    const logoutUrl = buildKeycloakLogoutUrl({ origin, idTokenHint });
    await clearSession();
    return { ok: true, logoutUrl };
  });
}
