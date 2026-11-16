import { NextResponse } from "next/server";
import { computePriceiqMarketGrades } from "@/lib/server/iqEngines";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const brand = url.searchParams.get("brand") ?? "";
  const model = url.searchParams.get("model") ?? "";
  const storageGbRaw = url.searchParams.get("storageGb") ?? "128";
  const market = url.searchParams.get("market") ?? "IN";
  const storageGb = Number(storageGbRaw);

  if (!brand || !model || !Number.isFinite(storageGb) || storageGb <= 0) {
    return NextResponse.json(
      { error: "brand, model, and storageGb are required." },
      { status: 400 }
    );
  }

  const data = await computePriceiqMarketGrades({ brand, model, storageGb, market });
  return NextResponse.json(data, { status: 200 });
}
