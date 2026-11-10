import { createHash } from "node:crypto";
import { query, queryOne, execute, tx, nowIso, newId, audit, parseJson } from "./db";
import { ALL_ROLES, hashPassword, generateTempPassword, HttpError, type Role } from "./auth";
import { getKeycloakConfig, type KeycloakConfig } from "./keycloak";

/**
 * Keycloak Realm Directory Synchronisation Service (`lib/server/keycloakSync.ts`)
 *
 * Supports both:
 * 1. Incremental Sync (`mode: "incremental"`):
 *    - Tracks a persistent per-realm watermark (`lastSyncedAt`, `lastSyncEpochMs`) and
 *      per-user SHA-256 state digests in `meta` (`keycloak_sync_state:<realm>`).
 *    - Queries Keycloak Admin Events (`/admin/realms/{realm}/admin-events`) and User Events
 *      (`/admin/realms/{realm}/events`) since `lastSyncEpochMs` to fetch only users whose
 *      profile, realm/client roles, or group memberships changed.
 *    - When Admin Events are unavailable or when syncing from a directory listing / JSON export,
 *      filters out unmodified users using `createdTimestamp`, `updatedTimestamp` / `modifyTimestamp`,
 *      and stored user digests prior to making N+1 role/group sub-requests or DB updates.
 * 2. Full Bulk Sync (`mode: "full"`):
 *    - Evaluates every user in the realm directory and optionally deactivates missing local users.
 */

export type KeycloakDirectoryUser = {
  id?: string;
  username: string;
  enabled?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  createdTimestamp?: number;
  updatedTimestamp?: number;
  attributes?: Record<string, string[] | string | undefined>;
  realmRoles?: string[];
  clientRoles?: Record<string, string[]>;
  groups?: string[];
};

export type SyncChangeItem = {
  username: string;
  userId: string;
  action: "created" | "updated" | "deactivated" | "unchanged" | "skipped";
  role: Role | null;
  orgId: string | null;
  orgName: string | null;
  storeId: string | null;
  storeName: string | null;
  active: boolean;
  changes?: string[];
  reason?: string;
};

export type KeycloakSyncMode = "incremental" | "full";

export type KeycloakSyncResult = {
  source: "admin_api" | "realm_json";
  mode: KeycloakSyncMode;
  realm: string;
  dryRun: boolean;
  deactivateMissing: boolean;
  since: string | null;
  syncedAt: string;
  totals: {
    totalInDirectory: number;
    evaluated: number;
    skippedUnmodified: number;
    created: number;
    updated: number;
    deactivated: number;
    unchanged: number;
    skipped: number;
  };
  items: SyncChangeItem[];
};

export type KeycloakSyncStatus = {
  keycloakEnabled: boolean;
  adminApiConfigured: boolean;
  realm: string;
  baseUrl: string;
  localUsersCount: number;
  activeUsersCount: number;
  orgsCount: number;
  watermark: {
    lastSyncedAt: string;
    lastSyncEpochMs: number;
    trackedUsersCount: number;
  } | null;
  lastSync: {
    at: string;
    actorId: string | null;
    source: string;
    mode: KeycloakSyncMode;
    since: string | null;
    totals: KeycloakSyncResult["totals"];
  } | null;
};

export type PersistedSyncWatermark = {
  realm: string;
  lastSyncedAt: string;
  lastSyncEpochMs: number;
  userDigests: Record<
    string,
    {
      kcId?: string;
      digest: string;
      modifiedAtMs: number;
    }
  >;
};

type OrgRef = {
  id: string;
  name: string;
  kind: "platform" | "client" | "partner";
  demo: number;
};

type StoreRef = {
  id: string;
  org_id: string;
  name: string;
  code: string;
};

type LocalUserRef = {
  id: string;
  org_id: string;
  store_id: string | null;
  username: string;
  name: string;
  role: Role;
  active: number;
};

function syncStateMetaKey(realm: string): string {
  return `keycloak_sync_state:${realm.trim().toLowerCase() || "swapup1"}`;
}

export async function getSyncWatermark(realm: string): Promise<PersistedSyncWatermark | null> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [syncStateMetaKey(realm)]
  );
  if (!row?.value) return null;
  return parseJson<PersistedSyncWatermark | null>(row.value, null);
}

async function saveSyncWatermark(state: PersistedSyncWatermark): Promise<void> {
  await execute(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [syncStateMetaKey(state.realm), JSON.stringify(state)]
  );
}

function firstAttr(
  attrs: Record<string, string[] | string | undefined> | undefined,
  ...keys: string[]
): string | null {
  if (!attrs) return null;
  for (const k of keys) {
    const raw = attrs[k];
    if (Array.isArray(raw) && raw.length > 0 && raw[0] != null) {
      const v = String(raw[0]).trim();
      if (v) return v;
    } else if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return null;
}

/**
 * Extracts the best-known modification timestamp (in epoch ms) from a Keycloak user record.
 * Checks `updatedTimestamp`, `modifyTimestamp` / `updated_at` / `lastModified` attributes,
 * and falls back to `createdTimestamp`.
 */
export function extractUserModifiedMs(kcUser: KeycloakDirectoryUser): number | null {
  if (typeof kcUser.updatedTimestamp === "number" && Number.isFinite(kcUser.updatedTimestamp)) {
    return kcUser.updatedTimestamp;
  }
  const attrTs = firstAttr(
    kcUser.attributes,
    "modifyTimestamp",
    "updatedTimestamp",
    "updated_at",
    "updatedAt",
    "lastModified"
  );
  if (attrTs) {
    const asNum = Number(attrTs);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 10_000_000_000 ? asNum * 1000 : asNum;
    }
    const parsedDate = Date.parse(attrTs);
    if (!Number.isNaN(parsedDate)) return parsedDate;
  }
  if (typeof kcUser.createdTimestamp === "number" && Number.isFinite(kcUser.createdTimestamp)) {
    return kcUser.createdTimestamp;
  }
  return null;
}

/**
 * Computes a deterministic SHA-256 digest of a Keycloak user's identity, enabled status,
 * attributes, roles, and groups so unchanged users can be skipped during incremental sync.
 */
export function computeKeycloakUserDigest(kcUser: KeycloakDirectoryUser): string {
  const normalizedAttrs: Record<string, string[]> = {};
  if (kcUser.attributes) {
    for (const k of Object.keys(kcUser.attributes).sort()) {
      const v = kcUser.attributes[k];
      if (Array.isArray(v)) {
        normalizedAttrs[k] = v.map(String).sort();
      } else if (typeof v === "string") {
        normalizedAttrs[k] = [v];
      }
    }
  }

  const normalizedClientRoles: Record<string, string[]> = {};
  if (kcUser.clientRoles) {
    for (const k of Object.keys(kcUser.clientRoles).sort()) {
      normalizedClientRoles[k] = [...(kcUser.clientRoles[k] ?? [])].map(String).sort();
    }
  }

  const canonical = {
    username: String(kcUser.username || "").trim().toLowerCase(),
    enabled: kcUser.enabled !== false,
    firstName: (kcUser.firstName || "").trim(),
    lastName: (kcUser.lastName || "").trim(),
    email: (kcUser.email || "").trim().toLowerCase(),
    attributes: normalizedAttrs,
    realmRoles: [...(kcUser.realmRoles ?? [])].map(String).sort(),
    clientRoles: normalizedClientRoles,
    groups: [...(kcUser.groups ?? [])].map(String).sort(),
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

/**
 * Determines whether a Keycloak user has been modified since `sinceEpochMs`.
 */
export function isKeycloakUserModifiedSince(
  kcUser: KeycloakDirectoryUser,
  sinceEpochMs: number | null,
  watermark: PersistedSyncWatermark | null,
  localExists: boolean
): boolean {
  // Always process if the user does not exist locally yet
  if (!localExists) return true;
  // If no previous watermark or since timestamp exists, treat as modified
  if (!sinceEpochMs || sinceEpochMs <= 0) return true;

  const username = String(kcUser.username || "").trim().toLowerCase();
  const prevEntry = watermark?.userDigests?.[username];

  const modifiedMs = extractUserModifiedMs(kcUser);
  if (modifiedMs !== null) {
    // If the user's timestamp is strictly newer than the last sync watermark, it was modified
    if (modifiedMs > sinceEpochMs) return true;
    // If the timestamp is older/equal AND we have a stored digest, verify the digest hasn't changed
    if (prevEntry) {
      return computeKeycloakUserDigest(kcUser) !== prevEntry.digest;
    }
    // Timestamp alone proves it was not modified after sinceEpochMs
    return false;
  }

  // When Keycloak user representation has no timestamp, compare against the stored state digest
  if (!prevEntry) return true;
  return computeKeycloakUserDigest(kcUser) !== prevEntry.digest;
}

function requiredOrgKindForRole(role: Role): "platform" | "partner" | "client" {
  if (role === "platform") return "platform";
  if (role === "partner") return "partner";
  return "client";
}

function resolveRoleFromDirectoryUser(
  kcUser: KeycloakDirectoryUser,
  existingRole?: Role | null
): Role {
  const attrRole = firstAttr(kcUser.attributes, "swapup_role", "role", "swapupRole");
  if (attrRole && ALL_ROLES.includes(attrRole as Role)) {
    return attrRole as Role;
  }

  const roleCandidates = new Set<string>();
  for (const r of kcUser.realmRoles ?? []) roleCandidates.add(r.trim().toLowerCase());
  for (const list of Object.values(kcUser.clientRoles ?? {})) {
    for (const r of list ?? []) roleCandidates.add(r.trim().toLowerCase());
  }
  for (const g of kcUser.groups ?? []) {
    const clean = g.replace(/^\/+/, "").split("/").pop()?.trim().toLowerCase();
    if (clean) roleCandidates.add(clean);
  }

  const priorityOrder: Role[] = ["platform", "partner", "org_admin", "store_manager", "advisor"];
  for (const r of priorityOrder) {
    if (roleCandidates.has(r)) return r;
  }

  return existingRole ?? "advisor";
}

function resolveOrgForUser(
  kcUser: KeycloakDirectoryUser,
  role: Role,
  orgs: OrgRef[],
  existingOrgId?: string | null
): OrgRef | null {
  const expectedKind = requiredOrgKindForRole(role);
  const matchingKindOrgs = orgs.filter((o) => o.kind === expectedKind);
  if (matchingKindOrgs.length === 0) return null;

  const byIdOrName = (needle: string | null | undefined): OrgRef | null => {
    if (!needle) return null;
    const clean = needle.trim();
    if (!clean) return null;
    const exactId = matchingKindOrgs.find((o) => o.id.toLowerCase() === clean.toLowerCase());
    if (exactId) return exactId;
    const exactName = matchingKindOrgs.find((o) => o.name.toLowerCase() === clean.toLowerCase());
    if (exactName) return exactName;
    return null;
  };

  const attrOrg = firstAttr(kcUser.attributes, "org_id", "organisation_id", "orgId", "org_name", "organisation");
  const fromAttr = byIdOrName(attrOrg);
  if (fromAttr) return fromAttr;

  for (const g of kcUser.groups ?? []) {
    const segments = g.split("/").map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const found = byIdOrName(seg);
      if (found) return found;
    }
  }

  if (existingOrgId) {
    const fromExisting = matchingKindOrgs.find((o) => o.id === existingOrgId);
    if (fromExisting) return fromExisting;
  }

  const nonDemo = matchingKindOrgs.find((o) => !o.demo);
  return nonDemo ?? matchingKindOrgs[0];
}

function resolveStoreForUser(
  kcUser: KeycloakDirectoryUser,
  role: Role,
  orgId: string,
  stores: StoreRef[],
  existingStoreId?: string | null
): StoreRef | null {
  if (role !== "store_manager" && role !== "advisor") {
    return null;
  }

  const orgStores = stores.filter((s) => s.org_id === orgId);
  if (orgStores.length === 0) return null;

  const matchStore = (needle: string | null | undefined): StoreRef | null => {
    if (!needle) return null;
    const clean = needle.trim().toLowerCase();
    if (!clean) return null;
    return (
      orgStores.find((s) => s.id.toLowerCase() === clean) ??
      orgStores.find((s) => s.code.toLowerCase() === clean) ??
      orgStores.find((s) => s.name.toLowerCase() === clean) ??
      null
    );
  };

  const attrStore = firstAttr(kcUser.attributes, "store_id", "storeId", "store_code", "storeCode", "store");
  const fromAttr = matchStore(attrStore);
  if (fromAttr) return fromAttr;

  for (const g of kcUser.groups ?? []) {
    const segments = g.split("/").map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const found = matchStore(seg);
      if (found) return found;
    }
  }

  if (existingStoreId) {
    const fromExisting = orgStores.find((s) => s.id === existingStoreId);
    if (fromExisting) return fromExisting;
  }

  return orgStores[0] ?? null;
}

/* ── Keycloak Admin REST API Client (Full & Incremental) ──────────────── */

export function isKeycloakAdminConfigured(cfg: KeycloakConfig = getKeycloakConfig()): boolean {
  if (!cfg.enabled || !cfg.baseUrl) return false;
  const hasAdminCreds = Boolean(cfg.adminUsername && cfg.adminPassword);
  const hasAdminClientSecret = Boolean(cfg.adminClientSecret);
  const hasWebServiceAccount = Boolean(cfg.clientId && cfg.clientSecret);
  return hasAdminCreds || hasAdminClientSecret || hasWebServiceAccount;
}

async function getKeycloakAdminToken(cfg: KeycloakConfig = getKeycloakConfig()): Promise<string> {
  if (!cfg.enabled || !cfg.baseUrl) {
    throw new HttpError(400, "Keycloak URL is not configured. Set KEYCLOAK_URL or upload a realm export JSON.");
  }

  const adminRealm = (process.env.KEYCLOAK_ADMIN_REALM || "master").trim();
  const attempts: { url: string; body: URLSearchParams; label: string }[] = [];

  if (cfg.adminUsername && cfg.adminPassword) {
    const params = new URLSearchParams({
      grant_type: "password",
      client_id: cfg.adminClientId || "admin-cli",
      username: cfg.adminUsername,
      password: cfg.adminPassword,
    });
    if (cfg.adminClientSecret) params.set("client_secret", cfg.adminClientSecret);
    attempts.push({
      url: `${cfg.baseUrl}/realms/${encodeURIComponent(adminRealm)}/protocol/openid-connect/token`,
      body: params,
      label: `password grant (${adminRealm}/${cfg.adminClientId})`,
    });
  }

  if (cfg.adminClientSecret) {
    attempts.push({
      url: `${cfg.baseUrl}/realms/${encodeURIComponent(cfg.realm)}/protocol/openid-connect/token`,
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.adminClientId,
        client_secret: cfg.adminClientSecret,
      }),
      label: `client_credentials (${cfg.realm}/${cfg.adminClientId})`,
    });
  }

  if (cfg.clientId && cfg.clientSecret) {
    attempts.push({
      url: `${cfg.baseUrl}/realms/${encodeURIComponent(cfg.realm)}/protocol/openid-connect/token`,
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      label: `client_credentials (${cfg.realm}/${cfg.clientId})`,
    });
  }

  if (attempts.length === 0) {
    throw new HttpError(
      400,
      "Keycloak Admin credentials are not configured. Set KEYCLOAK_ADMIN_USERNAME/PASSWORD or KEYCLOAK_CLIENT_SECRET."
    );
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: attempt.body.toString(),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { access_token?: string };
        if (data.access_token) return data.access_token;
      } else {
        const text = await res.text().catch(() => "");
        errors.push(`${attempt.label}: HTTP ${res.status} ${text.slice(0, 120)}`);
      }
    } catch (e) {
      errors.push(`${attempt.label}: ${(e as Error).message}`);
    }
  }

  throw new HttpError(
    502,
    `Could not authenticate with Keycloak Admin API (${errors.join("; ")}). Check KEYCLOAK_URL and admin credentials.`
  );
}

async function enrichKeycloakUserFromAdminApi(
  adminBase: string,
  headers: Record<string, string>,
  u: KeycloakDirectoryUser
): Promise<KeycloakDirectoryUser> {
  let realmRoles = Array.isArray(u.realmRoles) ? [...u.realmRoles] : [];
  let groups = Array.isArray(u.groups) ? [...u.groups] : [];

  const hasExplicitAttrRole = Boolean(firstAttr(u.attributes, "swapup_role", "role"));
  if (u.id && !hasExplicitAttrRole && realmRoles.length === 0) {
    try {
      const rolesRes = await fetch(`${adminBase}/users/${encodeURIComponent(u.id)}/role-mappings/realm`, {
        headers,
        cache: "no-store",
      });
      if (rolesRes.ok) {
        const roleObjs = (await rolesRes.json()) as Array<{ name?: string }>;
        realmRoles = roleObjs.map((r) => r.name || "").filter(Boolean);
      }
    } catch {
      // Fallback role resolution applies if role-mappings endpoint is restricted
    }
  }

  const hasExplicitOrgAttr = Boolean(firstAttr(u.attributes, "org_id", "organisation_id", "org_name"));
  if (u.id && !hasExplicitOrgAttr && groups.length === 0) {
    try {
      const groupsRes = await fetch(`${adminBase}/users/${encodeURIComponent(u.id)}/groups`, {
        headers,
        cache: "no-store",
      });
      if (groupsRes.ok) {
        const groupObjs = (await groupsRes.json()) as Array<{ path?: string; name?: string }>;
        groups = groupObjs.map((g) => g.path || g.name || "").filter(Boolean);
      }
    } catch {
      // Fallback org resolution applies if groups endpoint is restricted
    }
  }

  return {
    id: u.id,
    username: u.username,
    enabled: u.enabled ?? true,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    createdTimestamp: u.createdTimestamp,
    updatedTimestamp: u.updatedTimestamp,
    attributes: u.attributes,
    realmRoles,
    clientRoles: u.clientRoles,
    groups,
  };
}

/**
 * Queries Keycloak's `/admin-events` and `/events` endpoints for user/role/group modifications
 * since `sinceEpochMs`. Returns `null` if event auditing is disabled or unsupported on the realm,
 * or `{ modifiedUserIds, deletedUserIds }` when event logs are available.
 */
async function fetchModifiedUserIdsFromKeycloakEvents(
  adminBase: string,
  headers: Record<string, string>,
  sinceEpochMs: number
): Promise<{ modifiedUserIds: Set<string>; deletedUserIds: Set<string> } | null> {
  try {
    const dateFromIsoDate = new Date(Math.max(0, sinceEpochMs - 60_000)).toISOString().slice(0, 10);
    const adminEventsUrl = `${adminBase}/admin-events?dateFrom=${encodeURIComponent(dateFromIsoDate)}&max=500`;
    const res = await fetch(adminEventsUrl, { headers, cache: "no-store" });
    if (!res.ok) return null;

    const events = (await res.json()) as Array<{
      time?: number;
      operationType?: string;
      resourceType?: string;
      resourcePath?: string;
    }>;
    if (!Array.isArray(events)) return null;

    const modifiedUserIds = new Set<string>();
    const deletedUserIds = new Set<string>();

    for (const ev of events) {
      if (typeof ev.time === "number" && ev.time <= sinceEpochMs) continue;
      const path = String(ev.resourcePath || "");
      // Matches `users/<id>` or `users/<id>/role-mappings/...` or `users/<id>/groups/...`
      const match = /^users\/([^/]+)/.exec(path);
      if (!match?.[1]) continue;
      const kcUserId = match[1];
      if (ev.operationType === "DELETE" && path === `users/${kcUserId}`) {
        deletedUserIds.add(kcUserId);
      } else {
        modifiedUserIds.add(kcUserId);
      }
    }

    // Also check user self-service events (REGISTER, UPDATE_PROFILE, UPDATE_EMAIL)
    try {
      const userEventsRes = await fetch(
        `${adminBase}/events?dateFrom=${encodeURIComponent(dateFromIsoDate)}&max=500`,
        { headers, cache: "no-store" }
      );
      if (userEventsRes.ok) {
        const userEvents = (await userEventsRes.json()) as Array<{
          time?: number;
          type?: string;
          userId?: string;
        }>;
        if (Array.isArray(userEvents)) {
          for (const uev of userEvents) {
            if (typeof uev.time === "number" && uev.time <= sinceEpochMs) continue;
            if (
              uev.userId &&
              ["REGISTER", "UPDATE_PROFILE", "UPDATE_EMAIL", "CUSTOM_REQUIRED_ACTION"].includes(
                String(uev.type || "")
              )
            ) {
              modifiedUserIds.add(uev.userId);
            }
          }
        }
      }
    } catch {
      // User events endpoint is optional
    }

    // Only rely on the event-driven delta if at least one event was recorded on the realm
    // (if the realm has admin events turned off, `events` is always `[]`, so we fall back to timestamp/digest scan)
    if (events.length === 0 && modifiedUserIds.size === 0 && deletedUserIds.size === 0) {
      return null;
    }

    return { modifiedUserIds, deletedUserIds };
  } catch {
    return null;
  }
}

/**
 * Fetches users from the live Keycloak Admin REST API.
 * When `mode === "incremental"` and `sinceEpochMs` is provided:
 * 1. First attempts event-driven delta discovery (`/admin-events` + `/events`) to fetch ONLY the
 *    specific users modified since `sinceEpochMs` (`GET /admin/realms/{realm}/users/{id}`).
 * 2. If Admin Events are not enabled on the realm, fetches the user list (`briefRepresentation=false`)
 *    and filters out unmodified users via `isKeycloakUserModifiedSince` BEFORE issuing N+1
 *    `/role-mappings/realm` and `/groups` requests.
 */
export async function fetchKeycloakRealmUsersFromAdminApi(
  cfg: KeycloakConfig = getKeycloakConfig(),
  opts: {
    mode?: KeycloakSyncMode;
    sinceEpochMs?: number | null;
    watermark?: PersistedSyncWatermark | null;
    existingUsernames?: Set<string>;
  } = {}
): Promise<{
  users: KeycloakDirectoryUser[];
  totalInDirectory: number;
  skippedUnmodified: number;
}> {
  const token = await getKeycloakAdminToken(cfg);
  const adminBase = `${cfg.baseUrl}/admin/realms/${encodeURIComponent(cfg.realm)}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const mode = opts.mode ?? "full";
  const sinceEpochMs = opts.sinceEpochMs ?? null;

  // Strategy A: Event-driven incremental fetch when Admin Events are active on the realm
  if (mode === "incremental" && sinceEpochMs && sinceEpochMs > 0) {
    const delta = await fetchModifiedUserIdsFromKeycloakEvents(adminBase, headers, sinceEpochMs);
    if (delta) {
      const enrichedDelta: KeycloakDirectoryUser[] = [];
      for (const kcUserId of delta.modifiedUserIds) {
        if (delta.deletedUserIds.has(kcUserId)) continue;
        const uRes = await fetch(`${adminBase}/users/${encodeURIComponent(kcUserId)}`, {
          headers,
          cache: "no-store",
        });
        if (!uRes.ok) continue;
        const rawUser = (await uRes.json()) as KeycloakDirectoryUser;
        if (rawUser.username?.startsWith("service-account-")) continue;
        enrichedDelta.push(await enrichKeycloakUserFromAdminApi(adminBase, headers, rawUser));
      }
      const trackedCount = Object.keys(opts.watermark?.userDigests ?? {}).length;
      const totalEstimate = Math.max(trackedCount, enrichedDelta.length);
      return {
        users: enrichedDelta,
        totalInDirectory: totalEstimate,
        skippedUnmodified: Math.max(0, totalEstimate - enrichedDelta.length),
      };
    }
  }

  // Strategy B: Paginated directory fetch with pre-enrichment timestamp & digest filtering
  const usersRes = await fetch(`${adminBase}/users?max=500&briefRepresentation=false`, {
    headers,
    cache: "no-store",
  });
  if (!usersRes.ok) {
    const errText = await usersRes.text().catch(() => "");
    throw new HttpError(
      502,
      `Keycloak Admin API /users failed (${usersRes.status}): ${errText.slice(0, 180)}`
    );
  }

  const rawUsers = (await usersRes.json()) as KeycloakDirectoryUser[];
  const nonServiceUsers = rawUsers.filter((u) => !u.username?.startsWith("service-account-"));

  const enriched: KeycloakDirectoryUser[] = [];
  let skippedUnmodified = 0;

  for (const u of nonServiceUsers) {
    const uname = String(u.username || "").trim().toLowerCase();
    const localExists = opts.existingUsernames ? opts.existingUsernames.has(uname) : false;

    if (
      mode === "incremental" &&
      sinceEpochMs &&
      !isKeycloakUserModifiedSince(u, sinceEpochMs, opts.watermark ?? null, localExists)
    ) {
      skippedUnmodified++;
      continue;
    }

    enriched.push(await enrichKeycloakUserFromAdminApi(adminBase, headers, u));
  }

  return {
    users: enriched,
    totalInDirectory: nonServiceUsers.length,
    skippedUnmodified,
  };
}

/**
 * Extracts `KeycloakDirectoryUser[]` from either a full Keycloak Realm export JSON
 * (`{ realm: "swapup1", users: [...] }`) or a direct array of user representations.
 */
export function parseKeycloakUsersPayload(payload: unknown): {
  realmName: string;
  users: KeycloakDirectoryUser[];
} {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Provide a valid Keycloak realm export JSON or users array.");
  }

  if (Array.isArray(payload)) {
    return {
      realmName: getKeycloakConfig().realm,
      users: payload as KeycloakDirectoryUser[],
    };
  }

  const obj = payload as {
    realm?: string;
    users?: unknown[];
  };

  if (!Array.isArray(obj.users)) {
    throw new HttpError(400, "JSON payload does not contain a 'users' array.");
  }

  return {
    realmName: typeof obj.realm === "string" && obj.realm.trim() ? obj.realm.trim() : getKeycloakConfig().realm,
    users: obj.users as KeycloakDirectoryUser[],
  };
}

/**
 * Synchronises Keycloak directory users into the local `users` table.
 *
 * Defaults to `mode: "incremental"` when a prior sync watermark exists for the realm
 * (and `deactivateMissing` is false), so only users modified or added since the last sync
 * are fetched and updated. Pass `mode: "full"` to force a full bulk reconciliation.
 */
export async function syncKeycloakDirectoryToDb(opts: {
  directoryUsers?: KeycloakDirectoryUser[];
  source?: "admin_api" | "realm_json";
  mode?: KeycloakSyncMode;
  since?: string | number | null;
  realm?: string;
  deactivateMissing?: boolean;
  dryRun?: boolean;
  actorUserId?: string | null;
}): Promise<KeycloakSyncResult> {
  const cfg = getKeycloakConfig();
  const source = opts.source ?? (opts.directoryUsers ? "realm_json" : "admin_api");
  const realm = opts.realm || cfg.realm;
  const dryRun = Boolean(opts.dryRun);
  const deactivateMissing = Boolean(opts.deactivateMissing);

  const priorWatermark = await getSyncWatermark(realm);

  // Determine effective sync mode and `since` watermark timestamp
  let sinceEpochMs: number | null = null;
  if (opts.since !== undefined && opts.since !== null && opts.since !== "") {
    const num = Number(opts.since);
    sinceEpochMs = Number.isFinite(num) && num > 0 ? num : Date.parse(String(opts.since));
    if (Number.isNaN(sinceEpochMs)) sinceEpochMs = null;
  } else if (priorWatermark?.lastSyncEpochMs) {
    sinceEpochMs = priorWatermark.lastSyncEpochMs;
  }

  // Default to incremental mode whenever we have a watermark and aren't doing a full missing-user sweep
  const mode: KeycloakSyncMode =
    opts.mode ?? (sinceEpochMs && !deactivateMissing ? "incremental" : "full");
  const effectiveSinceMs = mode === "incremental" ? sinceEpochMs : null;
  const sinceIso = effectiveSinceMs ? new Date(effectiveSinceMs).toISOString() : null;

  const orgs = await query<OrgRef>(`SELECT id, name, kind, demo FROM orgs ORDER BY demo ASC, created_at ASC`);
  const stores = await query<StoreRef>(`SELECT id, org_id, name, code FROM stores ORDER BY created_at ASC`);
  const existingUsers = await query<LocalUserRef>(
    `SELECT id, org_id, store_id, username, name, role, active FROM users`
  );

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const existingByUsername = new Map(existingUsers.map((u) => [u.username.toLowerCase(), u]));
  const existingById = new Map(existingUsers.map((u) => [u.id, u]));
  const existingUsernamesSet = new Set(existingByUsername.keys());

  let candidateUsers: KeycloakDirectoryUser[];
  let totalInDirectory = 0;
  let skippedUnmodified = 0;

  if (opts.directoryUsers) {
    const nonService = opts.directoryUsers.filter(
      (u) => !String(u.username || "").trim().toLowerCase().startsWith("service-account-")
    );
    totalInDirectory = nonService.length;
    if (mode === "incremental" && effectiveSinceMs) {
      candidateUsers = [];
      for (const u of nonService) {
        const uname = String(u.username || "").trim().toLowerCase();
        const attrUid = firstAttr(u.attributes, "swapup_user_id", "swapupUserId");
        const localExists =
          existingByUsername.has(uname) || Boolean(attrUid && existingById.has(attrUid));
        if (isKeycloakUserModifiedSince(u, effectiveSinceMs, priorWatermark, localExists)) {
          candidateUsers.push(u);
        } else {
          skippedUnmodified++;
        }
      }
    } else {
      candidateUsers = nonService;
    }
  } else {
    const fetched = await fetchKeycloakRealmUsersFromAdminApi(cfg, {
      mode,
      sinceEpochMs: effectiveSinceMs,
      watermark: priorWatermark,
      existingUsernames: existingUsernamesSet,
    });
    candidateUsers = fetched.users;
    totalInDirectory = fetched.totalInDirectory;
    skippedUnmodified = fetched.skippedUnmodified;
  }

  const items: SyncChangeItem[] = [];
  const seenUserIds = new Set<string>();
  const seenUsernames = new Set<string>();
  const nextDigests: PersistedSyncWatermark["userDigests"] = {
    ...(priorWatermark?.userDigests ?? {}),
  };

  let created = 0;
  let updated = 0;
  let deactivated = 0;
  let unchanged = 0;
  let skipped = 0;

  const syncCompletedMs = Date.now();
  const syncedAt = new Date(syncCompletedMs).toISOString();

  await tx(async () => {
    for (const kcUser of candidateUsers) {
      const rawUsername = String(kcUser.username || "")
        .trim()
        .toLowerCase();

      if (!rawUsername || rawUsername.startsWith("service-account-")) {
        skipped++;
        items.push({
          username: rawUsername || "(empty)",
          userId: "",
          action: "skipped",
          role: null,
          orgId: null,
          orgName: null,
          storeId: null,
          storeName: null,
          active: false,
          reason: "Missing or service-account username",
        });
        continue;
      }

      if (!/^[a-z0-9._-]{3,32}$/.test(rawUsername)) {
        skipped++;
        items.push({
          username: rawUsername,
          userId: "",
          action: "skipped",
          role: null,
          orgId: null,
          orgName: null,
          storeId: null,
          storeName: null,
          active: false,
          reason: "Username does not match SwapUp format (3–32 lowercase letters, digits, . - _)",
        });
        continue;
      }

      const attrUserId = firstAttr(kcUser.attributes, "swapup_user_id", "swapupUserId");
      const existing =
        existingByUsername.get(rawUsername) ??
        (attrUserId ? existingById.get(attrUserId) : undefined);

      const role = resolveRoleFromDirectoryUser(kcUser, existing?.role);
      const resolvedOrg = resolveOrgForUser(kcUser, role, orgs, existing?.org_id);

      if (!resolvedOrg) {
        skipped++;
        items.push({
          username: rawUsername,
          userId: existing?.id ?? "",
          action: "skipped",
          role,
          orgId: null,
          orgName: null,
          storeId: null,
          storeName: null,
          active: false,
          reason: `No '${requiredOrgKindForRole(role)}' organisation exists for role '${role}'`,
        });
        continue;
      }

      const resolvedStore = resolveStoreForUser(
        kcUser,
        role,
        resolvedOrg.id,
        stores,
        existing?.store_id
      );

      if ((role === "store_manager" || role === "advisor") && !resolvedStore) {
        skipped++;
        items.push({
          username: rawUsername,
          userId: existing?.id ?? "",
          action: "skipped",
          role,
          orgId: resolvedOrg.id,
          orgName: resolvedOrg.name,
          storeId: null,
          storeName: null,
          active: false,
          reason: `Role '${role}' requires a store in organisation '${resolvedOrg.name}', but none exists`,
        });
        continue;
      }

      const fullName = [kcUser.firstName, kcUser.lastName]
        .map((s) => (s || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+SwapUp$/i, (m) => (existing?.name && !existing.name.endsWith("SwapUp") ? "" : m))
        .trim();
      const displayName = (
        existing?.name && fullName === `${existing.name.split(" ")[0]} SwapUp`
          ? existing.name
          : fullName || existing?.name || rawUsername
      ).slice(0, 80);

      const desiredActive = kcUser.enabled === false ? 0 : 1;
      const storeId = resolvedStore?.id ?? null;

      seenUsernames.add(rawUsername);
      nextDigests[rawUsername] = {
        kcId: kcUser.id,
        digest: computeKeycloakUserDigest(kcUser),
        modifiedAtMs: extractUserModifiedMs(kcUser) ?? syncCompletedMs,
      };

      if (existing) {
        seenUserIds.add(existing.id);

        // Guard against deactivating or demoting the last active platform user
        let effectiveActive = desiredActive;
        let effectiveRole = role;
        let effectiveOrg = resolvedOrg;

        if (existing.role === "platform" && existing.active === 1 && (desiredActive === 0 || role !== "platform")) {
          const otherPlatformActive = existingUsers.filter(
            (u) => u.id !== existing.id && u.role === "platform" && u.active === 1
          );
          if (otherPlatformActive.length === 0) {
            effectiveActive = 1;
            effectiveRole = "platform";
            effectiveOrg = orgById.get(existing.org_id) ?? resolvedOrg;
          }
        }

        const changes: string[] = [];
        if (existing.role !== effectiveRole) changes.push(`role: ${existing.role} → ${effectiveRole}`);
        if (existing.org_id !== effectiveOrg.id) {
          const oldOrgName = orgById.get(existing.org_id)?.name ?? existing.org_id;
          changes.push(`org: ${oldOrgName} → ${effectiveOrg.name}`);
        }
        if ((existing.store_id ?? null) !== storeId) {
          const oldStoreName = existing.store_id ? storeById.get(existing.store_id)?.name ?? existing.store_id : "none";
          const newStoreName = resolvedStore?.name ?? "none";
          changes.push(`store: ${oldStoreName} → ${newStoreName}`);
        }
        if (existing.name !== displayName) changes.push(`name: ${existing.name} → ${displayName}`);
        if (existing.active !== effectiveActive) {
          changes.push(`status: ${existing.active ? "active" : "deactivated"} → ${effectiveActive ? "active" : "deactivated"}`);
        }

        if (changes.length > 0) {
          if (!dryRun) {
            await execute(
              `UPDATE users
               SET role = $1, org_id = $2, store_id = $3, name = $4, active = $5
               WHERE id = $6`,
              [effectiveRole, effectiveOrg.id, storeId, displayName, effectiveActive, existing.id]
            );
          }
          existing.role = effectiveRole;
          existing.org_id = effectiveOrg.id;
          existing.store_id = storeId;
          existing.name = displayName;
          existing.active = effectiveActive;

          updated++;
          items.push({
            username: rawUsername,
            userId: existing.id,
            action: "updated",
            role: effectiveRole,
            orgId: effectiveOrg.id,
            orgName: effectiveOrg.name,
            storeId,
            storeName: resolvedStore?.name ?? null,
            active: Boolean(effectiveActive),
            changes,
          });
        } else {
          unchanged++;
          items.push({
            username: rawUsername,
            userId: existing.id,
            action: "unchanged",
            role: existing.role,
            orgId: existing.org_id,
            orgName: effectiveOrg.name,
            storeId: existing.store_id,
            storeName: resolvedStore?.name ?? null,
            active: Boolean(existing.active),
          });
        }
      } else {
        const newUserId =
          attrUserId && !existingById.has(attrUserId) ? attrUserId : newId("usr");
        seenUserIds.add(newUserId);

        if (!dryRun) {
          await execute(
            `INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              newUserId,
              resolvedOrg.id,
              storeId,
              rawUsername,
              displayName,
              role,
              hashPassword(generateTempPassword()),
              desiredActive,
              syncedAt,
            ]
          );
        }

        const createdRef: LocalUserRef = {
          id: newUserId,
          org_id: resolvedOrg.id,
          store_id: storeId,
          username: rawUsername,
          name: displayName,
          role,
          active: desiredActive,
        };
        existingUsers.push(createdRef);
        existingByUsername.set(rawUsername, createdRef);
        existingById.set(newUserId, createdRef);

        created++;
        items.push({
          username: rawUsername,
          userId: newUserId,
          action: "created",
          role,
          orgId: resolvedOrg.id,
          orgName: resolvedOrg.name,
          storeId,
          storeName: resolvedStore?.name ?? null,
          active: Boolean(desiredActive),
          changes: [`created as ${role} in ${resolvedOrg.name}`],
        });
      }
    }

    // Deactivate missing local users only during a full directory sweep
    if (deactivateMissing && mode === "full") {
      for (const localUser of existingUsers) {
        if (
          seenUserIds.has(localUser.id) ||
          seenUsernames.has(localUser.username.toLowerCase()) ||
          !localUser.active
        ) {
          continue;
        }

        if (localUser.role === "platform") {
          const activePlatformRemaining = existingUsers.filter(
            (u) => u.id !== localUser.id && u.role === "platform" && u.active === 1
          );
          if (activePlatformRemaining.length === 0) {
            continue;
          }
        }

        if (!dryRun) {
          await execute(
            `UPDATE users SET active = 0, pin_hash = NULL, pin_set_at = NULL WHERE id = $1`,
            [localUser.id]
          );
        }
        localUser.active = 0;
        delete nextDigests[localUser.username.toLowerCase()];
        deactivated++;

        const orgObj = orgById.get(localUser.org_id);
        const storeObj = localUser.store_id ? storeById.get(localUser.store_id) : null;
        items.push({
          username: localUser.username,
          userId: localUser.id,
          action: "deactivated",
          role: localUser.role,
          orgId: localUser.org_id,
          orgName: orgObj?.name ?? null,
          storeId: localUser.store_id,
          storeName: storeObj?.name ?? null,
          active: false,
          changes: ["deactivated (not present in Keycloak realm directory)"],
        });
      }
    }

    const totals = {
      totalInDirectory,
      evaluated: candidateUsers.length,
      skippedUnmodified,
      created,
      updated,
      deactivated,
      unchanged,
      skipped,
    };

    if (!dryRun) {
      await saveSyncWatermark({
        realm,
        lastSyncedAt: syncedAt,
        lastSyncEpochMs: syncCompletedMs,
        userDigests: nextDigests,
      });

      await audit({
        userId: opts.actorUserId ?? null,
        orgId: "org_platform",
        action: "keycloak.directory_sync",
        entity: "realm",
        entityId: realm,
        detail: {
          source,
          mode,
          since: sinceIso,
          realm,
          deactivateMissing,
          totals,
          changedUsers: items
            .filter((i) => i.action === "created" || i.action === "updated" || i.action === "deactivated")
            .map((i) => ({
              username: i.username,
              action: i.action,
              role: i.role,
              orgId: i.orgId,
              storeId: i.storeId,
              changes: i.changes,
            })),
        },
      });
    }
  });

  return {
    source,
    mode,
    realm,
    dryRun,
    deactivateMissing,
    since: sinceIso,
    syncedAt,
    totals: {
      totalInDirectory,
      evaluated: candidateUsers.length,
      skippedUnmodified,
      created,
      updated,
      deactivated,
      unchanged,
      skipped,
    },
    items,
  };
}

/**
 * Returns the current Keycloak directory sync status, active watermark, and most recent sync audit entry.
 */
export async function getKeycloakSyncStatus(): Promise<KeycloakSyncStatus> {
  const cfg = getKeycloakConfig();
  const counts = await queryOne<{
    total_users: string | number;
    active_users: string | number;
    orgs_count: string | number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total_users,
       (SELECT COUNT(*) FROM users WHERE active = 1) AS active_users,
       (SELECT COUNT(*) FROM orgs) AS orgs_count`
  );

  const watermark = await getSyncWatermark(cfg.realm);

  const lastAudit = await queryOne<{
    user_id: string | null;
    detail: string | null;
    at: string;
  }>(
    `SELECT user_id, detail, at
     FROM audit
     WHERE action = 'keycloak.directory_sync'
     ORDER BY at DESC, id DESC
     LIMIT 1`
  );

  const parsedDetail = parseJson<{
    source?: string;
    mode?: KeycloakSyncMode;
    since?: string | null;
    totals?: Partial<KeycloakSyncResult["totals"]>;
  } | null>(lastAudit?.detail ?? null, null);

  return {
    keycloakEnabled: cfg.enabled,
    adminApiConfigured: isKeycloakAdminConfigured(cfg),
    realm: cfg.realm,
    baseUrl: cfg.baseUrl,
    localUsersCount: Number(counts?.total_users || 0),
    activeUsersCount: Number(counts?.active_users || 0),
    orgsCount: Number(counts?.orgs_count || 0),
    watermark: watermark
      ? {
          lastSyncedAt: watermark.lastSyncedAt,
          lastSyncEpochMs: watermark.lastSyncEpochMs,
          trackedUsersCount: Object.keys(watermark.userDigests ?? {}).length,
        }
      : null,
    lastSync: lastAudit
      ? {
          at: lastAudit.at,
          actorId: lastAudit.user_id,
          source: parsedDetail?.source ?? "realm_json",
          mode: parsedDetail?.mode ?? "full",
          since: parsedDetail?.since ?? null,
          totals: {
            totalInDirectory: parsedDetail?.totals?.totalInDirectory ?? parsedDetail?.totals?.evaluated ?? 0,
            evaluated: parsedDetail?.totals?.evaluated ?? 0,
            skippedUnmodified: parsedDetail?.totals?.skippedUnmodified ?? 0,
            created: parsedDetail?.totals?.created ?? 0,
            updated: parsedDetail?.totals?.updated ?? 0,
            deactivated: parsedDetail?.totals?.deactivated ?? 0,
            unchanged: parsedDetail?.totals?.unchanged ?? 0,
            skipped: parsedDetail?.totals?.skipped ?? 0,
          },
        }
      : null,
  };
}
