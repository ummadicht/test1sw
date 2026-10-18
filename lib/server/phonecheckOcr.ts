import { createHash } from "node:crypto";
import { HttpError } from "./auth";
import { checkPcUpload, pcExtractRequest, readPcExtraction, GEMINI_DEFAULT_MODEL, PC_UPLOAD_MAX_BYTES, type PcUploadMime } from "../domain/phonecheck";

/**
 * AN UPLOADED PHONECHECK REPORT, READ BY AI (owner, 2026-10-17).
 *
 * A store without Phonecheck API access may upload the report itself — the A4
 * certificate as a PDF, or a photo / screenshot of it. Gemini reads it into the
 * SAME field names Phonecheck's JSON uses, under a strict response schema
 * (lib/domain/phonecheck.ts PC_EXTRACT_SCHEMA): every field nullable, and
 * anything not legible comes back null — never invented. What it read then goes
 * through `readPhonecheck(raw, { aiRead: true })` like any other record, and the
 * grade it feeds is always provisional (PV7 "uploaded by staff" + PV12 "read by
 * AI — check the figures").
 *
 * The key and model are GradeIQ's (~/projects/gradeiq/lib/deviceOcr.ts — read
 * only, the pattern copied, not imported):
 *   GEMINI_API_KEY   Google AI Studio key. Unset → 503; the JSON upload still works.
 *   GEMINI_MODEL     default "gemini-2.5-flash".
 *   GEMINI_API_BASE  default https://generativelanguage.googleapis.com/v1beta
 *                    (only ever changed to point a test at a stand-in).
 *   PHONECHECK_AI_TIMEOUT_MS  default 60000 — a multi-page PDF takes a while.
 *
 * ⚑ The key goes in the `x-goog-api-key` HEADER, never `?key=`: a URL ends up in
 *   proxy and error logs. It is never logged, never put in an error message (an
 *   upstream message that somehow carried it is scrubbed), never sent to a client.
 * ⚑ The file is read once and not kept: only what the AI read (as raw JSON) is
 *   stored with the record.
 * ⚑ Never inside `tx()` — one call can take tens of seconds.
 * ⚑ Out of credit (402) or a refused key (401 / 403): every read would fail the
 *   same way until someone fixes the account, so the reader reports itself OFF
 *   for 15 minutes (aiReaderConfigured → ok: false, with why) and no call is
 *   made — the desk greys the button and staff upload the Phonecheck JSON. A
 *   different key is tried at once. Kept in this process only.
 */

export type AiReaderConfig = { key: string; model: string; base: string; timeoutMs: number };

const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function aiReaderConfig(): AiReaderConfig {
  const e = process.env;
  const t = Number(e.PHONECHECK_AI_TIMEOUT_MS);
  return {
    key: (e.GEMINI_API_KEY || "").trim(),
    model: (e.GEMINI_MODEL || "").trim() || GEMINI_DEFAULT_MODEL,
    base: (e.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, ""),
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 60_000,
  };
}

/* ─────────── Google said no to the account: off for a while, not one failed upload after another ─────────── */

export const AI_OUTAGE_MS = 15 * 60_000;
type AccountRefusal = 401 | 402 | 403;
const OUTAGE_WHY: Readonly<Record<AccountRefusal, string>> = {
  402: "AI reader off — out of credit; upload the Phonecheck JSON.",
  401: "AI reader off — key refused; upload the Phonecheck JSON.",
  403: "AI reader off — key refused; upload the Phonecheck JSON.",
};
type Outage = { status: AccountRefusal; at: number; key: string };
// On globalThis so a dev-server module reload keeps it, like the database handle.
const G = globalThis as typeof globalThis & { __swapup_ai_outage?: Outage | null };
/** Which key an outage belongs to — a fingerprint, never the key. */
const keyPrint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

function noteOutcome(status: number, key: string): void {
  if (status === 401 || status === 402 || status === 403) G.__swapup_ai_outage = { status, at: Date.now(), key: keyPrint(key) };
  else if (status >= 200 && status < 300) G.__swapup_ai_outage = null;
}

/** Can an uploaded PDF / photo be read? `why` says what is missing — never the key itself. */
export function aiReaderConfigured(): { ok: boolean; why: string } {
  const c = aiReaderConfig();
  if (!c.key) return { ok: false, why: "AI reader not set up — upload the Phonecheck JSON." };
  if (!MODEL_RE.test(c.model)) return { ok: false, why: "AI reader off — bad model name; upload the Phonecheck JSON." };
  const out = G.__swapup_ai_outage;
  if (out && out.key === keyPrint(c.key) && Date.now() - out.at < AI_OUTAGE_MS) return { ok: false, why: OUTAGE_WHY[out.status] };
  return { ok: true, why: `AI reader: ${c.model}.` };
}

/** What Google's answer means, in one sentence staff can act on — never Google's own words (they could carry the key). */
function upstreamError(status: number): HttpError {
  if (status === 402) return new HttpError(503, "AI reader out of credit — top it up, or upload the Phonecheck JSON.");
  if (status === 429) return new HttpError(503, "AI reader over quota — try in a minute, or upload the JSON.");
  if (status === 401 || status === 403) return new HttpError(503, "AI reader key refused — upload the Phonecheck JSON.");
  if (status === 400) return new HttpError(422, "The AI couldn't read this file — try a clearer photo, or the JSON.");
  if (status === 404) return new HttpError(503, "AI model unavailable — upload the Phonecheck JSON.");
  return new HttpError(502, `AI reader failed (${status}) — try again, or upload the JSON.`);
}

/**
 * One uploaded file → a Phonecheck-shaped raw record (for readPhonecheck with
 * aiRead: true). Throws HttpError with a sentence staff can act on:
 * 400 / 413 the file itself, 503 not set up / out of credit / over quota,
 * 504 too slow, 502 a broken answer, 422 nothing legible.
 */
export async function readReportFile(bytes: Uint8Array, declaredMime: string | null): Promise<{ raw: Record<string, unknown>; mime: PcUploadMime; model: string }> {
  const file = checkPcUpload(declaredMime, bytes);
  if (!file.ok) throw new HttpError(bytes.length > PC_UPLOAD_MAX_BYTES ? 413 : 400, file.reason);
  const ready = aiReaderConfigured();
  if (!ready.ok) throw new HttpError(503, ready.why);
  const cfg = aiReaderConfig();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/models/${cfg.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.key },
      body: JSON.stringify(pcExtractRequest(file.mime, Buffer.from(bytes).toString("base64"))),
      signal: ctl.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new HttpError(504, "AI reader timed out — try again, or upload the JSON.");
    throw new HttpError(503, "Can't reach the AI reader — try again, or upload the JSON.");
  }
  noteOutcome(res.status, cfg.key);
  try {
    const text = await res.text();
    if (!res.ok) {
      throw upstreamError(res.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(502, "AI reader sent bad data — try again, or upload the JSON.");
    }
    const read = readPcExtraction(json);
    if (!read.ok) throw new HttpError(422, read.reason);
    return { raw: read.raw, mime: file.mime, model: cfg.model };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (ctl.signal.aborted) throw new HttpError(504, "AI reader timed out — try again, or upload the JSON.");
    throw new HttpError(502, "AI reader's answer unreadable — try again, or upload the JSON.");
  } finally {
    clearTimeout(timer);
  }
}
