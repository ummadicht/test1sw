import { NextResponse } from "next/server";
import { consumeHandoff } from "@/lib/server/mobileAuth";

export async function GET(req: Request, ctx: { params: Promise<{ nonce: string }> }) {
  const { nonce } = await ctx.params;
  const next = await consumeHandoff(nonce);
  const base = process.env.SWAPUP_PUBLIC_URL || new URL(req.url).origin;
  return NextResponse.redirect(new URL(next, base), { status: 303, headers: { "cache-control": "no-store" } });
}
