import { handle, body } from "@/lib/server/http";
import { ensureSeeded } from "@/lib/server/seed";
import {
  authenticateByFingerprint,
  enrollFingerprint,
  listFingerprintProfiles,
} from "@/lib/server/fingerprintAuth";

export async function GET() {
  return handle(async () => {
    await ensureSeeded();
    return await listFingerprintProfiles();
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    await ensureSeeded();
    const b = await body<{
      action?: "login" | "enroll";
      credentialId?: string;
      username?: string;
      password?: string;
      scannerType?: "webauthn" | "usb_optical" | "bluetooth_scanner";
      scannerModel?: string;
      fingerLabel?: string;
      minutiaeQuality?: number;
      publicKey?: string;
      clientDataJSON?: string;
      authenticatorData?: string;
      signature?: string;
      setWebCookie?: boolean;
    }>(req);

    if (b.action === "enroll") {
      return await enrollFingerprint(b);
    }
    return await authenticateByFingerprint(b);
  });
}
