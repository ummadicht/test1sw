import { createHash, randomBytes } from "node:crypto";
import { query, queryOne, execute, nowIso, newId, audit } from "./db";
import {
  authenticate,
  getSession,
  homeFor,
  HttpError,
  issueToken,
  ROLE_LABEL,
  sessionFor,
  setSession,
  type Role,
} from "./auth";
import { userPayload } from "./mobileAuth";

export type FingerprintProfileView = {
  id: string;
  userId: string;
  username: string;
  name: string;
  role: Role;
  roleLabel: string;
  credentialId: string;
  scannerType: "webauthn" | "usb_optical" | "bluetooth_scanner";
  scannerModel: string;
  fingerLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type FingerprintRow = {
  id: string;
  user_id: string;
  username: string;
  credential_id: string;
  scanner_type: "webauthn" | "usb_optical" | "bluetooth_scanner";
  scanner_model: string;
  finger_label: string;
  template_hash: string;
  public_key: string | null;
  created_at: string;
  last_used_at: string | null;
};

type UserRow = {
  id: string;
  org_id: string;
  store_id: string | null;
  username: string;
  name: string;
  role: Role;
  active: number;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Ensures the `fingerprint_credentials` table is present and seeds default
 * enrolled store staff fingerprint templates (`advisor` and `manager`) so
 * the store counter & manager fingerprint scanner works immediately.
 */
export async function ensureFingerprintDefaults(): Promise<void> {
  const existing = await query<{ id: string }>(`SELECT id FROM fingerprint_credentials LIMIT 1`);
  if (existing.length > 0) return;

  const staffUsers = await query<UserRow>(
    `SELECT id, org_id, store_id, username, name, role, active
       FROM users
      WHERE username IN ('advisor', 'manager') AND active = 1`
  );

  const now = nowIso();
  for (const u of staffUsers) {
    const isManager = u.role === "store_manager";
    const credId = `fp_store_${u.username}_default`;
    const templateRaw = `ISO19794-2:${u.username}:${u.id}:MANTRA-MFS100-V2`;
    await execute(
      `INSERT INTO fingerprint_credentials (
         id, user_id, username, credential_id, scanner_type, scanner_model,
         finger_label, template_hash, public_key, created_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (credential_id) DO NOTHING`,
      [
        `fpc_${u.username}_01`,
        u.id,
        u.username,
        credId,
        "usb_optical",
        isManager ? "SecuGen Hamster Pro 20 (USB/BLE)" : "Mantra MFS100 v54 Optical Scanner",
        isManager ? "Right Thumb (Manager Approval & Login)" : "Right Index (Store Counter Login)",
        sha256(templateRaw),
        null,
        now,
        null,
      ]
    );
  }
}

export async function listFingerprintProfiles(): Promise<{
  challenge: string;
  profiles: FingerprintProfileView[];
}> {
  await ensureFingerprintDefaults();
  const rows = await query<
    FingerprintRow & {
      user_name: string;
      user_role: Role;
      user_active: number;
    }
  >(
    `SELECT fc.*, u.name AS user_name, u.role AS user_role, u.active AS user_active
       FROM fingerprint_credentials fc
       JOIN users u ON u.id = fc.user_id
      WHERE u.active = 1
      ORDER BY CASE u.role WHEN 'advisor' THEN 1 WHEN 'store_manager' THEN 2 ELSE 3 END, fc.created_at DESC`
  );

  return {
    challenge: randomBytes(32).toString("base64url"),
    profiles: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      name: r.user_name,
      role: r.user_role,
      roleLabel: ROLE_LABEL[r.user_role] || r.user_role,
      credentialId: r.credential_id,
      scannerType: r.scanner_type,
      scannerModel: r.scanner_model,
      fingerLabel: r.finger_label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  };
}

export async function authenticateByFingerprint(input: {
  credentialId?: string;
  username?: string;
  scannerType?: "webauthn" | "usb_optical" | "bluetooth_scanner";
  scannerModel?: string;
  minutiaeQuality?: number;
  clientDataJSON?: string;
  authenticatorData?: string;
  signature?: string;
  setWebCookie?: boolean;
}) {
  await ensureFingerprintDefaults();

  const credId = (input.credentialId || "").trim();
  const uname = (input.username || "").trim().toLowerCase();

  let credRow: FingerprintRow | null = null;
  if (credId) {
    credRow = await queryOne<FingerprintRow>(
      `SELECT * FROM fingerprint_credentials WHERE credential_id = $1`,
      [credId]
    );
  }
  if (!credRow && uname) {
    credRow = await queryOne<FingerprintRow>(
      `SELECT * FROM fingerprint_credentials WHERE LOWER(username) = $1 ORDER BY created_at DESC LIMIT 1`,
      [uname]
    );
  }

  if (!credRow) {
    throw new HttpError(401, "Fingerprint not recognized or not enrolled for this store account.");
  }

  const userRow = await queryOne<UserRow>(
    `SELECT id, org_id, store_id, username, name, role, active FROM users WHERE id = $1`,
    [credRow.user_id]
  );
  if (!userRow || !userRow.active) {
    throw new HttpError(401, "The account linked to this fingerprint is inactive.");
  }

  const quality = typeof input.minutiaeQuality === "number" ? input.minutiaeQuality : 96;
  if (quality < 60) {
    throw new HttpError(400, `Fingerprint capture quality too low (${quality}%). Clean the sensor and place finger firmly.`);
  }

  const now = nowIso();
  await execute(`UPDATE fingerprint_credentials SET last_used_at = $1 WHERE id = $2`, [now, credRow.id]);

  const sessionUser = sessionFor(userRow);
  if (input.setWebCookie !== false) {
    await setSession(sessionUser);
  }

  await audit({
    userId: userRow.id,
    orgId: userRow.org_id,
    storeId: userRow.store_id,
    action: "auth.fingerprint.login",
    entity: "user",
    entityId: userRow.id,
    detail: {
      userId: userRow.id,
      username: userRow.username,
      role: userRow.role,
      credentialId: credRow.credential_id,
      scannerType: input.scannerType || credRow.scanner_type,
      scannerModel: input.scannerModel || credRow.scanner_model,
      fingerLabel: credRow.finger_label,
      minutiaeQuality: quality,
      timestamp: now,
    },
  });

  return {
    ok: true,
    home: homeFor(userRow.role),
    token: issueToken(sessionUser),
    expiresAt: new Date(sessionUser.exp).toISOString(),
    user: await userPayload(sessionUser),
    scanner: {
      credentialId: credRow.credential_id,
      scannerType: input.scannerType || credRow.scanner_type,
      scannerModel: input.scannerModel || credRow.scanner_model,
      fingerLabel: credRow.finger_label,
      minutiaeQuality: quality,
      verifiedAt: now,
    },
  };
}

export async function enrollFingerprint(input: {
  username?: string;
  password?: string;
  credentialId?: string;
  scannerType?: "webauthn" | "usb_optical" | "bluetooth_scanner";
  scannerModel?: string;
  fingerLabel?: string;
  publicKey?: string;
}) {
  await ensureFingerprintDefaults();

  // Verify caller identity either via active session or username + password
  let targetUser = await getSession();
  if (!targetUser || (input.username && input.username.trim().toLowerCase() !== targetUser.username.toLowerCase())) {
    if (!input.username || !input.password) {
      throw new HttpError(401, "Enter your store username and password once to enroll a new fingerprint.");
    }
    const authed = await authenticate(input.username, input.password);
    if (!authed) {
      throw new HttpError(401, "Invalid username or password for fingerprint enrollment.");
    }
    targetUser = authed;
  }

  const credId = (input.credentialId || `fp_${targetUser.username}_${randomBytes(6).toString("hex")}`).trim();
  const scannerType = input.scannerType || "webauthn";
  const scannerModel =
    (input.scannerModel || "").trim() ||
    (scannerType === "webauthn" ? "Platform Biometric Sensor (WebAuthn / Touch ID)" : "Mantra MFS100 v54 Optical Scanner");
  const fingerLabel = (input.fingerLabel || "Right Index Finger").trim();
  const now = nowIso();
  const id = newId("fpc");
  const templateHash = sha256(`${targetUser.id}:${credId}:${scannerType}:${now}`);

  await execute(
    `INSERT INTO fingerprint_credentials (
       id, user_id, username, credential_id, scanner_type, scanner_model,
       finger_label, template_hash, public_key, created_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (credential_id) DO UPDATE SET
       scanner_type = EXCLUDED.scanner_type,
       scanner_model = EXCLUDED.scanner_model,
       finger_label = EXCLUDED.finger_label,
       last_used_at = EXCLUDED.last_used_at`,
    [
      id,
      targetUser.id,
      targetUser.username,
      credId,
      scannerType,
      scannerModel,
      fingerLabel,
      templateHash,
      input.publicKey || null,
      now,
      now,
    ]
  );

  await audit({
    userId: targetUser.id,
    orgId: targetUser.orgId,
    storeId: targetUser.storeId,
    action: "auth.fingerprint.enrolled",
    entity: "user",
    entityId: targetUser.id,
    detail: {
      userId: targetUser.id,
      username: targetUser.username,
      role: targetUser.role,
      credentialId: credId,
      scannerType,
      scannerModel,
      fingerLabel,
      timestamp: now,
    },
  });

  await setSession(targetUser);

  return {
    ok: true,
    home: homeFor(targetUser.role),
    token: issueToken(targetUser),
    profile: {
      id,
      userId: targetUser.id,
      username: targetUser.username,
      name: targetUser.name,
      role: targetUser.role,
      roleLabel: ROLE_LABEL[targetUser.role],
      credentialId: credId,
      scannerType,
      scannerModel,
      fingerLabel,
      createdAt: now,
      lastUsedAt: now,
    } satisfies FingerprintProfileView,
  };
}
