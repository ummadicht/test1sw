import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { query, queryOne, execute, nowIso, newId } from "./db";
import { ALL_ROLES, hashPassword, generateTempPassword, type Role } from "./auth";

/**
 * Keycloak OpenID Connect (OIDC) & Realm Management for SwapUp (realm: "swapup").
 *
 * Supports:
 * 1. OIDC Authorization Code Flow (Popup-first for iframe environments + standard redirect)
 * 2. OIDC Direct Access Grants (Resource Owner Password Credentials for counter/mobile login)
 * 3. JWKS RS256 Bearer Token verification for API requests
 * 4. Automatic user/role/tenant synchronization into SwapUp's database
 * 5. Dynamic & static Keycloak Realm JSON export for the `swapup` realm
 */

export const DEFAULT_KEYCLOAK_REALM = "swapup1";
export const DEFAULT_KEYCLOAK_CLIENT_ID = "swapup-web";
export const DEFAULT_KEYCLOAK_MOBILE_CLIENT_ID = "swapup-mobile";
export const DEFAULT_KEYCLOAK_CLIENT_SECRET = "swapup-keycloak-client-secret-2026";

export const DEV_APP_ORIGIN = "https://ais-dev-egeiwczs7kiexah24wg34c-992872337627.asia-east1.run.app";
export const SHARED_APP_ORIGIN = "https://ais-pre-egeiwczs7kiexah24wg34c-992872337627.asia-east1.run.app";

export type KeycloakConfig = {
  enabled: boolean;
  baseUrl: string;
  realm: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowLocalFallback: boolean;
  adminClientId: string;
  adminClientSecret: string;
  adminUsername: string;
  adminPassword: string;
};

export function getKeycloakConfig(): KeycloakConfig {
  const rawUrl = (process.env.KEYCLOAK_URL || process.env.NEXT_PUBLIC_KEYCLOAK_URL || "").trim().replace(/\/$/, "");
  const realm = (process.env.KEYCLOAK_REALM || process.env.NEXT_PUBLIC_KEYCLOAK_REALM || DEFAULT_KEYCLOAK_REALM).trim();
  const issuer =
    (process.env.KEYCLOAK_ISSUER || "").trim().replace(/\/$/, "") ||
    (rawUrl ? `${rawUrl}/realms/${encodeURIComponent(realm)}` : "");

  return {
    enabled: Boolean(rawUrl || process.env.KEYCLOAK_ISSUER),
    baseUrl: rawUrl,
    realm,
    issuer,
    clientId: (process.env.KEYCLOAK_CLIENT_ID || DEFAULT_KEYCLOAK_CLIENT_ID).trim(),
    clientSecret: (process.env.KEYCLOAK_CLIENT_SECRET || DEFAULT_KEYCLOAK_CLIENT_SECRET).trim(),
    allowLocalFallback: process.env.KEYCLOAK_ALLOW_LOCAL_FALLBACK !== "0",
    adminClientId: (process.env.KEYCLOAK_ADMIN_CLIENT_ID || "admin-cli").trim(),
    adminClientSecret: (process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || "").trim(),
    adminUsername: (process.env.KEYCLOAK_ADMIN_USERNAME || "").trim(),
    adminPassword: (process.env.KEYCLOAK_ADMIN_PASSWORD || "").trim(),
  };
}

export function oidcEndpoints(cfg = getKeycloakConfig()) {
  const base = `${cfg.issuer}/protocol/openid-connect`;
  return {
    issuer: cfg.issuer,
    auth: `${base}/auth`,
    token: `${base}/token`,
    userinfo: `${base}/userinfo`,
    certs: `${base}/certs`,
    logout: `${base}/logout`,
  };
}

function stateSecret(): string {
  return process.env.SWAPUP_SESSION_SECRET || process.env.KEYCLOAK_CLIENT_SECRET || "swapup-keycloak-state-secret-dev";
}

export type OAuthStatePayload = {
  nonce: string;
  next: string | null;
  redirectUri: string;
  exp: number;
};

export function encodeOAuthState(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeOAuthState(state: string | null | undefined): OAuthStatePayload | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  try {
    const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload;
    if (!parsed?.redirectUri || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function resolveAppOrigin(explicitOrigin?: string | null): string {
  const candidate = (explicitOrigin || process.env.APP_URL || process.env.SWAPUP_PUBLIC_URL || DEV_APP_ORIGIN).trim().replace(/\/$/, "");
  return candidate;
}

export function getKeycloakCallbackUrl(origin?: string | null): string {
  return `${resolveAppOrigin(origin)}/api/auth/keycloak/callback`;
}

export function buildKeycloakAuthUrl(opts: { origin?: string | null; next?: string | null }): {
  enabled: boolean;
  url: string | null;
  realm: string;
  clientId: string;
  redirectUri: string;
  issuer: string;
} {
  const cfg = getKeycloakConfig();
  const redirectUri = getKeycloakCallbackUrl(opts.origin);
  if (!cfg.enabled) {
    return {
      enabled: false,
      url: null,
      realm: cfg.realm,
      clientId: cfg.clientId,
      redirectUri,
      issuer: cfg.issuer,
    };
  }

  const state = encodeOAuthState({
    nonce: randomBytes(12).toString("base64url"),
    next: opts.next ?? null,
    redirectUri,
    exp: Date.now() + 10 * 60_000,
  });

  const endpoints = oidcEndpoints(cfg);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  });

  return {
    enabled: true,
    url: `${endpoints.auth}?${params.toString()}`,
    realm: cfg.realm,
    clientId: cfg.clientId,
    redirectUri,
    issuer: cfg.issuer,
  };
}

export function buildKeycloakLogoutUrl(opts: { origin?: string | null; idTokenHint?: string | null }): string | null {
  const cfg = getKeycloakConfig();
  if (!cfg.enabled) return null;
  const endpoints = oidcEndpoints(cfg);
  const postLogout = `${resolveAppOrigin(opts.origin)}/login`;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    post_logout_redirect_uri: postLogout,
  });
  if (opts.idTokenHint) {
    params.set("id_token_hint", opts.idTokenHint);
  }
  return `${endpoints.logout}?${params.toString()}`;
}

export type KeycloakTokenClaims = {
  sub: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  swapup_role?: string;
  org_id?: string;
  store_id?: string;
  swapup_user_id?: string;
  roles?: string[];
  groups?: string[];
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
};

type JwksCache = {
  issuer: string;
  fetchedAt: number;
  keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[];
};

let jwksCache: JwksCache | null = null;

async function getJwksKeys(cfg = getKeycloakConfig()): Promise<(JsonWebKey & { kid?: string })[]> {
  if (jwksCache && jwksCache.issuer === cfg.issuer && Date.now() - jwksCache.fetchedAt < 5 * 60_000) {
    return jwksCache.keys;
  }
  const endpoints = oidcEndpoints(cfg);
  const res = await fetch(endpoints.certs, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Keycloak JWKS (${res.status})`);
  }
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { issuer: cfg.issuer, fetchedAt: Date.now(), keys };
  return keys;
}

export async function verifyKeycloakJwt(jwt: string, cfg = getKeycloakConfig()): Promise<KeycloakTokenClaims | null> {
  const parts = (jwt || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { kid?: string; alg?: string };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as KeycloakTokenClaims;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    if (cfg.enabled) {
      const keys = await getJwksKeys(cfg);
      const jwk = keys.find((k) => !header.kid || k.kid === header.kid) ?? keys[0];
      if (!jwk) return null;
      const pubKey = createPublicKey({ key: jwk, format: "jwk" });
      const data = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
      const signature = Buffer.from(parts[2], "base64url");
      const valid = cryptoVerify("RSA-SHA256", data, pubKey, signature);
      if (!valid) return null;
    } else {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function extractRole(claims: KeycloakTokenClaims, fallbackRole?: Role): Role {
  if (claims.swapup_role && ALL_ROLES.includes(claims.swapup_role as Role)) {
    return claims.swapup_role as Role;
  }
  const candidates: string[] = [
    ...(claims.roles ?? []),
    ...(claims.realm_access?.roles ?? []),
    ...(claims.resource_access?.[DEFAULT_KEYCLOAK_CLIENT_ID]?.roles ?? []),
    ...(claims.groups ?? []).map((g) => g.replace(/^\/+/, "").split("/").pop() || ""),
  ];
  const priorityOrder: Role[] = ["platform", "partner", "org_admin", "store_manager", "advisor"];
  for (const r of priorityOrder) {
    if (candidates.includes(r)) return r;
  }
  return fallbackRole ?? "advisor";
}

export type SyncedUserRow = {
  id: string;
  org_id: string;
  store_id: string | null;
  username: string;
  name: string;
  role: Role;
  active: number;
};

/**
 * Synchronizes a verified Keycloak user (from ID/Access token claims) with SwapUp's `users` table
 * so all foreign keys, store scopes, and audit records work seamlessly.
 */
export async function syncKeycloakUserToDb(claims: KeycloakTokenClaims): Promise<SyncedUserRow | null> {
  const rawUsername = (claims.preferred_username || claims.email?.split("@")[0] || claims.sub || "")
    .trim()
    .toLowerCase();
  if (!rawUsername) return null;

  const existing = await queryOne<SyncedUserRow>(
    `SELECT id, org_id, store_id, username, name, role, active FROM users WHERE lower(username) = $1`,
    [rawUsername]
  );

  const role = extractRole(claims, existing?.role);
  const expectedKind = role === "platform" ? "platform" : role === "partner" ? "partner" : "client";
  const orgsOfKind = await query<{ id: string; name: string; demo: number }>(
    `SELECT id, name, demo FROM orgs WHERE kind = $1 ORDER BY demo ASC, created_at ASC`,
    [expectedKind]
  );

  let resolvedOrgId = "";
  if (claims.org_id) {
    const match = orgsOfKind.find(
      (o) => o.id.toLowerCase() === claims.org_id!.toLowerCase() || o.name.toLowerCase() === claims.org_id!.toLowerCase()
    );
    if (match) resolvedOrgId = match.id;
  }
  if (!resolvedOrgId && Array.isArray(claims.groups)) {
    for (const g of claims.groups) {
      for (const seg of g.split("/").map((s) => s.trim()).filter(Boolean)) {
        const match = orgsOfKind.find((o) => o.id.toLowerCase() === seg.toLowerCase() || o.name.toLowerCase() === seg.toLowerCase());
        if (match) {
          resolvedOrgId = match.id;
          break;
        }
      }
      if (resolvedOrgId) break;
    }
  }
  if (!resolvedOrgId && existing?.org_id && orgsOfKind.some((o) => o.id === existing.org_id)) {
    resolvedOrgId = existing.org_id;
  }
  if (!resolvedOrgId) {
    resolvedOrgId = orgsOfKind[0]?.id ?? (role === "platform" ? "org_platform" : role === "partner" ? "ptn_demo" : "org_samsung_svc");
  }

  let resolvedStoreId: string | null = null;
  if (role === "store_manager" || role === "advisor") {
    const orgStores = await query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM stores WHERE org_id = $1 ORDER BY created_at ASC`,
      [resolvedOrgId]
    );
    if (claims.store_id) {
      const needle = claims.store_id.trim().toLowerCase();
      const matched = orgStores.find(
        (s) => s.id.toLowerCase() === needle || s.code.toLowerCase() === needle || s.name.toLowerCase() === needle
      );
      if (matched) resolvedStoreId = matched.id;
    }
    if (!resolvedStoreId && existing?.store_id && orgStores.some((s) => s.id === existing.store_id)) {
      resolvedStoreId = existing.store_id;
    }
    if (!resolvedStoreId) {
      resolvedStoreId = orgStores[0]?.id ?? null;
    }
  }

  const displayName =
    (claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || existing?.name || rawUsername).trim();

  if (existing) {
    if (!existing.active) return null;
    if (
      existing.role !== role ||
      existing.name !== displayName ||
      existing.org_id !== resolvedOrgId ||
      existing.store_id !== resolvedStoreId
    ) {
      await execute(
        `UPDATE users SET role = $1, name = $2, org_id = $3, store_id = $4 WHERE id = $5`,
        [role, displayName.slice(0, 80), resolvedOrgId, resolvedStoreId, existing.id]
      );
    }
    return {
      ...existing,
      role,
      name: displayName.slice(0, 80),
      org_id: resolvedOrgId,
      store_id: resolvedStoreId,
    };
  }

  const userId = claims.swapup_user_id || newId("usr");
  await execute(
    `INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
     ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name, org_id = EXCLUDED.org_id, store_id = EXCLUDED.store_id`,
    [userId, resolvedOrgId, resolvedStoreId, rawUsername, displayName.slice(0, 80), role, hashPassword(generateTempPassword()), nowIso()]
  );

  return await queryOne<SyncedUserRow>(
    `SELECT id, org_id, store_id, username, name, role, active FROM users WHERE lower(username) = $1`,
    [rawUsername]
  );
}

export async function exchangeKeycloakCode(
  code: string,
  stateRaw: string
): Promise<{ user: SyncedUserRow; idToken: string | null; next: string | null }> {
  const cfg = getKeycloakConfig();
  if (!cfg.enabled) {
    throw new Error("Keycloak is not configured. Set KEYCLOAK_URL in environment variables.");
  }
  const state = decodeOAuthState(stateRaw);
  if (!state) {
    throw new Error("Invalid or expired OAuth state. Please try signing in again.");
  }

  const endpoints = oidcEndpoints(cfg);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: state.redirectUri,
  });
  if (cfg.clientSecret) {
    body.set("client_secret", cfg.clientSecret);
  }

  const tokenRes = await fetch(endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => "");
    throw new Error(`Keycloak token exchange failed (${tokenRes.status}): ${errText.slice(0, 200)}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    id_token?: string;
    refresh_token?: string;
  };

  let claims =
    (tokenData.id_token ? await verifyKeycloakJwt(tokenData.id_token, cfg) : null) ??
    (await verifyKeycloakJwt(tokenData.access_token, cfg));

  if (!claims) {
    // Fallback to /userinfo endpoint
    const uiRes = await fetch(endpoints.userinfo, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: "no-store",
    });
    if (!uiRes.ok) {
      throw new Error("Could not verify Keycloak token or fetch userinfo.");
    }
    claims = (await uiRes.json()) as KeycloakTokenClaims;
  }

  const user = await syncKeycloakUserToDb(claims);
  if (!user) {
    throw new Error("Your Keycloak account is disabled or could not be mapped to a SwapUp user.");
  }

  return {
    user,
    idToken: tokenData.id_token ?? null,
    next: state.next,
  };
}

/**
 * Authenticates username + password directly against Keycloak's token endpoint
 * using Resource Owner Password Credentials (`grant_type=password`).
 */
export async function authenticateViaKeycloakPassword(
  username: string,
  password: string
): Promise<{ matched: boolean; user: SyncedUserRow | null; unreachable?: boolean }> {
  const cfg = getKeycloakConfig();
  if (!cfg.enabled) {
    return { matched: false, user: null, unreachable: true };
  }

  const endpoints = oidcEndpoints(cfg);
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: cfg.clientId,
    username: (username || "").trim(),
    password: password || "",
    scope: "openid profile email",
  });
  if (cfg.clientSecret) {
    body.set("client_secret", cfg.clientSecret);
  }

  try {
    const res = await fetch(endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });

    if (!res.ok) {
      return { matched: false, user: null };
    }

    const tokenData = (await res.json()) as { access_token: string; id_token?: string };
    const claims =
      (await verifyKeycloakJwt(tokenData.access_token, cfg)) ??
      (tokenData.id_token ? await verifyKeycloakJwt(tokenData.id_token, cfg) : null);

    if (!claims) {
      return { matched: false, user: null };
    }

    const user = await syncKeycloakUserToDb(claims);
    return { matched: Boolean(user), user };
  } catch {
    return { matched: false, user: null, unreachable: true };
  }
}

/* ── Keycloak Realm JSON Generator (`swapup` realm) ─────────────────────── */

export type KeycloakRealmUserSeed = {
  id: string;
  username: string;
  name: string;
  role: Role;
  org_id: string;
  store_id: string | null;
  active: number;
};

const SEED_USER_DEFAULTS: KeycloakRealmUserSeed[] = [
  { id: "usr_platform", username: "platform", name: "SwapUp Ops", role: "platform", org_id: "org_platform", store_id: null, active: 1 },
  { id: "usr_partner", username: "partner", name: "Partner Ops (demo)", role: "partner", org_id: "ptn_demo", store_id: null, active: 1 },
  { id: "usr_samsung", username: "samsung", name: "Programme Admin (demo)", role: "org_admin", org_id: "org_samsung_svc", store_id: null, active: 1 },
  { id: "usr_mgr_and", username: "manager", name: "Priya Nair", role: "store_manager", org_id: "org_samsung_svc", store_id: "st_and", active: 1 },
  { id: "usr_adv_and", username: "advisor", name: "Rahul Desai", role: "advisor", org_id: "org_samsung_svc", store_id: "st_and", active: 1 },
  { id: "usr_mgr_kor", username: "manager.kor", name: "Kiran Rao", role: "store_manager", org_id: "org_samsung_svc", store_id: "st_kor", active: 1 },
  { id: "usr_adv_kor", username: "advisor.kor", name: "Divya Shetty", role: "advisor", org_id: "org_samsung_svc", store_id: "st_kor", active: 1 },
  { id: "usr_xc_admin", username: "xc.admin", name: "Experience Admin (demo)", role: "org_admin", org_id: "org_xc", store_id: null, active: 1 },
  { id: "usr_xc_mgr", username: "xc.manager", name: "Arjun Mehta", role: "store_manager", org_id: "org_xc", store_id: "st_cpx", active: 1 },
  { id: "usr_xc_adv", username: "xc.advisor", name: "Sana Qureshi", role: "advisor", org_id: "org_xc", store_id: "st_cpx", active: 1 },
];

function buildProtocolMappers() {
  return [
    {
      name: "swapup-role-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "userinfo.token.claim": "true",
        "user.attribute": "swapup_role",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "swapup_role",
        "jsonType.label": "String",
      },
    },
    {
      name: "swapup-org-id-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "userinfo.token.claim": "true",
        "user.attribute": "org_id",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "org_id",
        "jsonType.label": "String",
      },
    },
    {
      name: "swapup-store-id-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "userinfo.token.claim": "true",
        "user.attribute": "store_id",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "store_id",
        "jsonType.label": "String",
      },
    },
    {
      name: "swapup-user-id-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      consentRequired: false,
      config: {
        "userinfo.token.claim": "true",
        "user.attribute": "swapup_user_id",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "swapup_user_id",
        "jsonType.label": "String",
      },
    },
    {
      name: "swapup-realm-roles-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-realm-role-mapper",
      consentRequired: false,
      config: {
        "multivalued": "true",
        "userinfo.token.claim": "true",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "roles",
        "jsonType.label": "String",
      },
    },
  ];
}

export async function generateKeycloakRealmJson(extraOrigin?: string | null, realmOverride?: string | null) {
  const realmName = (realmOverride || getKeycloakConfig().realm || DEFAULT_KEYCLOAK_REALM).trim();
  let dbUsers: KeycloakRealmUserSeed[] = [];
  try {
    dbUsers = await query<KeycloakRealmUserSeed>(
      `SELECT id, username, name, role, org_id, store_id, active FROM users ORDER BY created_at, id`
    );
  } catch {
    dbUsers = [];
  }
  const usersSource = dbUsers.length > 0 ? dbUsers : SEED_USER_DEFAULTS;
  const defaultPassword = process.env.SWAPUP_DEMO_PASSWORD || "swapup2026";

  const origins = Array.from(
    new Set(
      [
        DEV_APP_ORIGIN,
        SHARED_APP_ORIGIN,
        extraOrigin ? extraOrigin.replace(/\/$/, "") : null,
        "http://localhost:3000",
        "http://localhost:4500",
      ].filter((x): x is string => Boolean(x))
    )
  );

  const redirectUris = [
    ...origins.map((o) => `${o}/api/auth/keycloak/callback`),
    ...origins.map((o) => `${o}/*`),
  ];

  const webOrigins = [...origins, "+"];
  const mappers = buildProtocolMappers();

  return {
    id: realmName,
    realm: realmName,
    displayName: "SwapUp",
    displayNameHtml: "<strong>SwapUp</strong> Trade-In &amp; Upgrade Platform",
    enabled: true,
    sslRequired: "external",
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    editUsernameAllowed: false,
    bruteForceProtected: true,
    permanentLockout: false,
    maxFailureWaitSeconds: 600,
    minimumQuickLoginWaitSeconds: 60,
    waitIncrementSeconds: 60,
    quickLoginCheckMilliSeconds: 1000,
    maxDeltaTimeSeconds: 600,
    failureFactor: 8,
    accessTokenLifespan: 43200,
    ssoSessionIdleTimeout: 43200,
    ssoSessionMaxLifespan: 86400,
    roles: {
      realm: [
        {
          name: "platform",
          description: "SwapUp platform — onboards clients and partners, sees everything",
          composite: false,
          clientRole: false,
        },
        {
          name: "org_admin",
          description: "Programme admin — stores, credit limits, campaigns, catalogues, reports",
          composite: false,
          clientRole: false,
        },
        {
          name: "store_manager",
          description: "Store manager — one store: the counter, its credit line, pickups, its advisors",
          composite: false,
          clientRole: false,
        },
        {
          name: "advisor",
          description: "Counter advisor — one store: the counter only",
          composite: false,
          clientRole: false,
        },
        {
          name: "partner",
          description: "Buyback partner — pickups, verification, settlement and rate cards",
          composite: false,
          clientRole: false,
        },
      ],
    },
    defaultRoles: ["advisor"],
    clients: [
      {
        clientId: DEFAULT_KEYCLOAK_CLIENT_ID,
        name: "SwapUp Web Desk & Admin Console",
        description: "Next.js web application and API server for SwapUp Experience Centers",
        enabled: true,
        protocol: "openid-connect",
        clientAuthenticatorType: "client-secret",
        secret: DEFAULT_KEYCLOAK_CLIENT_SECRET,
        publicClient: false,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: true,
        serviceAccountsEnabled: true,
        frontchannelLogout: true,
        rootUrl: DEV_APP_ORIGIN,
        baseUrl: "/",
        redirectUris,
        webOrigins,
        attributes: {
          "post.logout.redirect.uris": origins.map((o) => `${o}/*`).join("##"),
          "pkce.code.challenge.method": "",
        },
        protocolMappers: mappers,
      },
      {
        clientId: DEFAULT_KEYCLOAK_MOBILE_CLIENT_ID,
        name: "SwapUp Store Companion App",
        description: "Public OIDC client for SwapUp Store Android / tablet companion app",
        enabled: true,
        protocol: "openid-connect",
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: true,
        serviceAccountsEnabled: false,
        redirectUris: ["swapupstore://*", ...redirectUris],
        webOrigins,
        protocolMappers: mappers,
      },
    ],
    users: usersSource.map((u) => {
      const nameParts = u.name.trim().split(/\s+/);
      const firstName = nameParts[0] || u.username;
      const lastName = nameParts.slice(1).join(" ") || "SwapUp";
      const attributes: Record<string, string[]> = {
        swapup_role: [u.role],
        org_id: [u.org_id],
        swapup_user_id: [u.id],
      };
      if (u.store_id) {
        attributes.store_id = [u.store_id];
      }
      return {
        username: u.username,
        enabled: Boolean(u.active),
        emailVerified: true,
        firstName,
        lastName,
        email: `${u.username}@swapup.local`,
        attributes,
        credentials: [
          {
            type: "password",
            value: defaultPassword,
            temporary: false,
          },
        ],
        realmRoles: [u.role],
      };
    }),
  };
}
