import { NextResponse } from "next/server";
import { handle, readCapped } from "@/lib/server/http";
import { phonecheckConfig, readWebhookBody, receiveWebhook, webhookAuth, WEBHOOK_MAX_BYTES } from "@/lib/server/phonecheck";

/**
 * Phonecheck's push (docs/GRADING.md). Secret in `X-PC-Secret` or
 * `Authorization: Bearer` — never a ?secret= query, which would land in logs.
 * No secret set → 503; wrong → 401. JSON or form-encoded, ≤ 512 KB, one record,
 * an array, {devices}, {data} or {deviceInfo}; ≤ 100 records. Stored, never
 * attached to a case. 200 {ok, received, stored, stale, rejected}; 500 only on
 * a database error (Phonecheck retries on 500/502/504/408 only).
 */
export async function POST(req: Request) {
  const auth = webhookAuth(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: { "cache-control": "no-store" } });
  const tooBig = () => NextResponse.json({ error: `The webhook body is over ${WEBHOOK_MAX_BYTES / 1024} KB.` }, { status: 413 });
  // Counted as it arrives: a chunked body with no Content-Length is cut off at the limit too.
  let text: string;
  try {
    text = new TextDecoder().decode(await readCapped(req, WEBHOOK_MAX_BYTES, () => new Error("too big")));
  } catch {
    return tooBig();
  }
  return handle(() => receiveWebhook(readWebhookBody(text, req.headers.get("content-type"))));
}

/** Health check: is the webhook there, and is it secured. */
export async function GET() {
  const secret = phonecheckConfig().webhookSecret;
  return NextResponse.json({ ok: true, service: "phonecheck", secured: !!secret && secret.length >= 24 }, { headers: { "cache-control": "no-store" } });
}
