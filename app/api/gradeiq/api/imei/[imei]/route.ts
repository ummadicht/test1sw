import { NextResponse } from "next/server";
import { lookupLocalGradeiqImei } from "@/lib/server/iqEngines";

export async function GET(_req: Request, ctx: { params: Promise<{ imei: string }> }) {
  const { imei } = await ctx.params;
  const clean = decodeURIComponent(imei).trim();
  if (!/^\d{15}$/.test(clean)) {
    return NextResponse.json({ error: "Invalid 15-digit IMEI" }, { status: 400 });
  }
  const result = await lookupLocalGradeiqImei(clean);
  return NextResponse.json(result, { status: 200 });
}
