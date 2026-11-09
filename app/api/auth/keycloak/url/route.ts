import { NextResponse } from "next/server";
import { buildKeycloakAuthUrl } from "@/lib/server/keycloak";
import { publicOrigin } from "@/lib/server/http";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clientOrigin = url.searchParams.get("origin");
  const next = url.searchParams.get("next");
  const origin = clientOrigin || publicOrigin(req);
  const info = buildKeycloakAuthUrl({ origin, next });
  return NextResponse.json(info, {
    headers: { "Cache-Control": "no-store" },
  });
}
