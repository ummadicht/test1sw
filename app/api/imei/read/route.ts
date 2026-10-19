import { handle, readCapped } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { MAX_PHOTO_CHARS, readImeiPhoto } from "@/lib/server/imeiResolve";

/**
 * POST /api/imei/read (staff: advisor / store manager) — "Read the screen": a photo of the customer's
 * *#06# screen → GradeIQ's AI reads the IMEI, server to server (call 0, docs/GRADEIQ-INTEGRATION.md).
 *
 *   body { "photo": "data:image/jpeg;base64,…" }
 *   200  { "imei": "35…", "imei2": "35…" | null, "valid": true | false }   valid = the IMEI's check digit
 *   503  { "error": "The screen reader is off — scan or type the IMEI.", "reason": "reader_off" }
 *   422  { "error": "No IMEI found in that photo — try again or type it.", "reason": "not_found" }
 *
 * Nothing is saved: the app shows "Read: 35… — confirm", and the confirmed number is saved with
 * PATCH /api/cases/<id> {imei, imei2}.
 */
export async function POST(req: Request) {
  return handle(async () => {
    await requireUser(["advisor", "store_manager"]);
    const raw = await readCapped(req, MAX_PHOTO_CHARS + 4096, () => new HttpError(413, "That photo is too large — take it again."));
    let b: { photo?: unknown };
    try {
      b = JSON.parse(new TextDecoder().decode(raw)) as { photo?: unknown };
    } catch {
      throw new HttpError(400, "Expected a JSON body.");
    }
    return readImeiPhoto(b?.photo);
  });
}
