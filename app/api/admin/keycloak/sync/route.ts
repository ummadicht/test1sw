import { timingSafeEqual } from "node:crypto";
import { handle, body as parseBody } from "@/lib/server/http";
import { getSession, HttpError } from "@/lib/server/auth";
import {
  getKeycloakSyncStatus,
  parseKeycloakUsersPayload,
  syncKeycloakDirectoryToDb,
  type KeycloakSyncMode,
} from "@/lib/server/keycloakSync";

async function authorizeSyncRequest(req: Request): Promise<{ actorId: string | null }> {
  const syncSecret = (process.env.KEYCLOAK_SYNC_SECRET || "").trim();
  const headerSecret = (req.headers.get("x-keycloak-sync-secret") || "").trim();

  if (syncSecret && headerSecret) {
    const a = Buffer.from(syncSecret, "utf8");
    const b = Buffer.from(headerSecret, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { actorId: null };
    }
  }

  const u = await getSession();
  if (!u || u.role !== "platform") {
    throw new HttpError(403, "Only SwapUp platform staff can sync the Keycloak directory.");
  }
  return { actorId: u.id };
}

export async function GET(req: Request) {
  return handle(async () => {
    await authorizeSyncRequest(req);
    const status = await getKeycloakSyncStatus();
    return { status };
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { actorId } = await authorizeSyncRequest(req);
    const body = await parseBody<{
      source?: "admin_api" | "realm_json";
      mode?: KeycloakSyncMode;
      since?: string | number | null;
      realmJson?: unknown;
      users?: unknown;
      deactivateMissing?: boolean;
      dryRun?: boolean;
    }>(req);

    const hasInlinePayload = body.realmJson !== undefined || body.users !== undefined;
    let directoryUsers = undefined;
    let realm: string | undefined = undefined;
    let source: "admin_api" | "realm_json" = body.source ?? (hasInlinePayload ? "realm_json" : "admin_api");

    if (hasInlinePayload) {
      const parsed = parseKeycloakUsersPayload(body.realmJson ?? body.users);
      directoryUsers = parsed.users;
      realm = parsed.realmName;
      source = "realm_json";
    }

    const mode: KeycloakSyncMode | undefined =
      body.mode === "incremental" || body.mode === "full" ? body.mode : undefined;

    const result = await syncKeycloakDirectoryToDb({
      directoryUsers,
      source,
      mode,
      since: body.since,
      realm,
      deactivateMissing: Boolean(body.deactivateMissing),
      dryRun: Boolean(body.dryRun),
      actorUserId: actorId,
    });

    const status = await getKeycloakSyncStatus();
    return { result, status };
  });
}
