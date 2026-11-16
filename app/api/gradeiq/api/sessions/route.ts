import { NextResponse } from "next/server";
import { createLocalGradeiqSession } from "@/lib/server/iqEngines";

export async function POST(req: Request) {
  let body: { client?: string; channel?: string; model?: string } = {};
  try {
    body = (await req.json()) as { client?: string; channel?: string; model?: string };
  } catch {
    body = {};
  }
  const created = await createLocalGradeiqSession(body);
  return NextResponse.json(created, { status: 201 });
}
