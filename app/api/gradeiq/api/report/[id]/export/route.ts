import { NextResponse } from "next/server";
import { getLocalGradeiqSessionSnapshot } from "@/lib/server/iqEngines";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snap = await getLocalGradeiqSessionSnapshot(id);
  if (!snap) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      reportVersion: "2.1",
      provider: "SwapUp GradeIQ",
      sessionId: snap.id,
      client: snap.client_id,
      channel: snap.channel,
      expectedModel: snap.expected_model,
      cosmeticGrade: snap.cosmetic_grade,
      functionalGrade: snap.functional_grade,
      overallGrade: snap.overall_grade,
      cosmetic: snap.cosmetic,
      screen: snap.screen,
      functional: snap.functional,
      device: snap.device,
      identity: snap.identity,
      photos: snap.photos,
      ocr: snap.ocr,
      exportedAt: new Date().toISOString(),
    },
    { status: 200 }
  );
}
