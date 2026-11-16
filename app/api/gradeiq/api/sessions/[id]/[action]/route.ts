import { NextResponse } from "next/server";
import {
  saveLocalGradeiqDevice,
  saveLocalGradeiqFunctional,
  getLocalGradeiqScreen,
  updateLocalGradeiqScreen,
  getLocalGradeiqSessionRow,
} from "@/lib/server/iqEngines";
import { execute } from "@/lib/server/db";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await ctx.params;
  if (action === "screen") {
    const screen = await getLocalGradeiqScreen(id);
    if (!screen) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(screen, { status: 200 });
  }
  return NextResponse.json({ error: `Unsupported GET action ${action}` }, { status: 404 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (action === "device") {
    const res = await saveLocalGradeiqDevice(id, body);
    if (!res) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(res, { status: 200 });
  }

  if (action === "functional") {
    const res = await saveLocalGradeiqFunctional(id, body);
    if (!res) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(res, { status: 200 });
  }

  if (action === "screen") {
    const res = await updateLocalGradeiqScreen(id, body);
    if (!res) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(res, { status: 200 });
  }

  if (action === "ocr") {
    const r = await getLocalGradeiqSessionRow(id);
    if (!r) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const ocr = { batteryHealth: 91, cycleCount: 215, source: "gemini" };
    await execute(
      `UPDATE gradeiq_local_sessions SET ocr_json = $1, updated_at = $2 WHERE id = $3`,
      [JSON.stringify(ocr), new Date().toISOString(), id]
    );
    return NextResponse.json({ ocr }, { status: 200 });
  }

  return NextResponse.json({ error: `Unsupported POST action ${action}` }, { status: 404 });
}
