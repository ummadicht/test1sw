import { NextResponse } from "next/server";
import { generateKeycloakRealmJson } from "@/lib/server/keycloak";
import { ensureSeeded } from "@/lib/server/seed";
import { publicOrigin } from "@/lib/server/http";

export async function GET(req: Request) {
  await ensureSeeded();
  const url = new URL(req.url);
  const origin = url.searchParams.get("origin") || publicOrigin(req);
  const realmParam = url.searchParams.get("realm");
  const realmJson = await generateKeycloakRealmJson(origin, realmParam);
  const body = JSON.stringify(realmJson, null, 2);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${realmJson.realm}-realm-export.json"`,
      "Cache-Control": "no-store",
    },
  });
}
