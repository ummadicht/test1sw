import { NextResponse } from "next/server";
import { handle, readCapped } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { attachForCase, phonecheckForCase, pullForCase, uploadFileForCase, uploadForCase, type CasePhonecheckResult, type PcSummary } from "@/lib/server/phonecheck";
import { PC_UPLOAD_MAX_BYTES } from "@/lib/domain/phonecheck";

/** GET → { configured: {ok, why}, station, stationFrom, canPull, why, aiReader: {ok, why}, records: PcSummary[] } for the case's phone. Counter staff only. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    return phonecheckForCase(u, (await ctx.params).id);
  });
}

const JSON_MAX = 256 * 1024;
/** A file sent as base64 inside JSON is a third bigger than the file. */
const FILE_JSON_MAX = Math.ceil(PC_UPLOAD_MAX_BYTES * 1.4) + 64 * 1024;
const tooBig = (what: string) => new HttpError(413, `${what.replace(/\.$/, "")} — limit ${PC_UPLOAD_MAX_BYTES / 1048576} MB a file, 256 KB JSON.`);

type JsonBody = {
  mode?: unknown;
  imei?: unknown;
  record?: unknown;
  recordId?: unknown;
  confirmMismatch?: unknown;
  reason?: unknown;
  /** mode "upload_file": the report as a data URL ("data:application/pdf;base64,…"). */
  file?: unknown;
  name?: unknown;
};

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * One door for a case's Phonecheck result (docs/GRADING.md). Advisor or store
 * manager; the case still at the counter.
 *
 *   JSON {mode:"pull", imei?}             fetch Phonecheck's newest check of the phone (when switched on)
 *   JSON {mode:"upload", record}           the Phonecheck JSON (one record or an array), ≤ 256 KB
 *   JSON {mode:"attach", recordId}         a stored record (from the webhook, say)
 *   multipart {file}                       the report as a PDF / JPEG / PNG / WebP, read by AI, ≤ 8 MB
 *   JSON {mode:"upload_file", file, name?} the same file as a data URL, for clients without multipart
 * Upload and attach also take confirmMismatch + reason (store manager only) for a
 * report whose IMEI isn't the case's.
 *
 * → { case, record, outcome: "attached" | "not_found" | "stale", note, extracted? }.
 * IMEI mismatch → 409 { error, outcome: "mismatch", record } — the error names both numbers.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const u = await requireUser(["advisor", "store_manager"]);
    const { id } = await ctx.params;
    const ct = req.headers.get("content-type") || "";
    let out: CasePhonecheckResult;
    if (/multipart\/form-data/i.test(ct)) {
      // Counted as it arrives: a chunked body with no Content-Length is cut off at the limit too.
      const raw = await readCapped(req, PC_UPLOAD_MAX_BYTES + 64 * 1024, () => tooBig("That upload is too big."));
      let form: FormData;
      try {
        form = await new Response(raw, { headers: { "content-type": ct } }).formData();
      } catch {
        throw new HttpError(400, "Send the report as a form upload with a `file` field.");
      }
      const file = form.get("file");
      if (!file || typeof file === "string") throw new HttpError(400, "Choose the Phonecheck report file (PDF or photo).");
      if (file.size > PC_UPLOAD_MAX_BYTES) throw tooBig("That file is too big.");
      const reason = form.get("reason");
      out = await uploadFileForCase(
        u,
        id,
        { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || null, name: "name" in file ? String(file.name) : null },
        { confirmMismatch: form.get("confirmMismatch") === "true", reason: typeof reason === "string" ? reason : undefined }
      );
    } else {
      const text = new TextDecoder().decode(await readCapped(req, FILE_JSON_MAX, () => tooBig("That upload is too big.")));
      let b: JsonBody;
      try {
        b = JSON.parse(text) as JsonBody;
      } catch {
        throw new HttpError(400, "Expected a JSON body.");
      }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Expected a JSON object with a mode.");
      if (b.mode !== "upload_file" && text.length > JSON_MAX) throw tooBig("That JSON is too big.");
      const opts = { confirmMismatch: b.confirmMismatch === true, reason: typeof b.reason === "string" ? b.reason : undefined };
      switch (b.mode) {
        case "pull":
          out = await pullForCase(u, id, { imei: b.imei });
          break;
        case "upload":
          if (b.record === undefined) throw new HttpError(400, "Send the Phonecheck JSON as `record`.");
          out = await uploadForCase(u, id, b.record, opts);
          break;
        case "attach":
          out = await attachForCase(u, id, b.recordId, opts);
          break;
        case "upload_file": {
          const m = typeof b.file === "string" ? DATA_URL.exec(b.file.trim()) : null;
          if (!m) throw new HttpError(400, "Send the report file as a data URL (data:application/pdf;base64,…).");
          const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
          if (bytes.length > PC_UPLOAD_MAX_BYTES) throw tooBig("That file is too big.");
          out = await uploadFileForCase(u, id, { bytes, mime: m[1], name: typeof b.name === "string" ? b.name : null }, opts);
          break;
        }
        default:
          throw new HttpError(400, `Unknown mode${typeof b.mode === "string" ? `: ${b.mode}` : ""} — pull, upload, upload_file or attach.`);
      }
    }
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // The one error that carries data: the record, so a manager can attach it with a reason.
    if (e && typeof e === "object" && (e as { name?: string }).name === "PhonecheckMismatch") {
      const m = e as HttpError & { record: PcSummary };
      return NextResponse.json({ error: m.message, outcome: "mismatch", record: m.record }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    return handle(() => {
      throw e;
    });
  }
}
