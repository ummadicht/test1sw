import { NextResponse } from "next/server";
import {
  getLocalGradeiqSessionSnapshot,
  completeLocalGradeiqCapture,
  type GradePreset,
} from "@/lib/server/iqEngines";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snap = await getLocalGradeiqSessionSnapshot(id);
  if (!snap) {
    return NextResponse.json({ error: `GradeIQ session ${id} not found.` }, { status: 404 });
  }
  return NextResponse.json(snap, { status: 200 });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: {
    preset?: GradePreset;
    displayVerdict?: "pass" | "fail";
    oemVerdict?: "original" | "replaced" | "unknown";
    batteryHealth?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const snap = await completeLocalGradeiqCapture(id, body);
  if (!snap) {
    return NextResponse.json({ error: `GradeIQ session ${id} not found.` }, { status: 404 });
  }
  return NextResponse.json(snap, { status: 200 });
}
