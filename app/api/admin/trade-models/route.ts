import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { saveTradeModel } from "@/lib/server/admin-extra";

type In = Parameters<typeof saveTradeModel>[1];

function optInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  return Number(v);
}

/** Add or update a trade-in model in the catalogue: { id?, brand?, model, series?, variants, releaseYear?, supportEndYear?, serviceTier?, carePlusFee?, maxTradePrice?, modelCodes?, sourceLabel? }. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<Record<string, unknown>>(req);
    const input: In = {
      id: b.id ? String(b.id) : null,
      brand: b.brand ? String(b.brand) : "Samsung",
      model: String(b.model ?? ""),
      series: b.series ? String(b.series) : null,
      variants: Array.isArray(b.variants) ? b.variants.map(String) : String(b.variants ?? ""),
      releaseYear: optInt(b.releaseYear),
      supportEndYear: optInt(b.supportEndYear),
      serviceTier: b.serviceTier ? String(b.serviceTier) : null,
      carePlusFee: optInt(b.carePlusFee),
      maxTradePrice: optInt(b.maxTradePrice),
      modelCodes: Array.isArray(b.modelCodes) ? b.modelCodes.map(String) : b.modelCodes ? String(b.modelCodes) : undefined,
      sourceLabel: b.sourceLabel ? String(b.sourceLabel) : undefined,
    };
    const models = await saveTradeModel(u, input);
    return { models };
  });
}
