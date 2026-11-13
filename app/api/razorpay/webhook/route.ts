import { NextResponse } from "next/server";
import { handle, readCapped } from "@/lib/server/http";
import { handleRazorpayWebhook } from "@/lib/server/razorpay";

const MAX_WEBHOOK_BYTES = 1024 * 512; // 512 KB

export async function POST(req: Request) {
  const sig = req.headers.get("x-razorpay-signature");
  let rawBody = "";
  try {
    const bytes = await readCapped(req, MAX_WEBHOOK_BYTES, () => new Error("Body exceeds 512KB limit"));
    rawBody = new TextDecoder().decode(bytes);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 413 });
  }

  return handle(async () => handleRazorpayWebhook(rawBody, sig));
}

export async function GET() {
  return NextResponse.json(
    { ok: true, service: "razorpay-webhook", timestamp: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } }
  );
}
