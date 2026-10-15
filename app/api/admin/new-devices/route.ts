import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { saveNewDevice } from "@/lib/server/catalog";

type In = Parameters<typeof saveNewDevice>[1];

/** Add or edit a new phone the counter can sell: { orgId?, id?, model, series, variant, price, supportEndYear?, active?, sourceLabel? }. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<Partial<Omit<In, "price" | "supportEndYear">> & { price?: unknown; supportEndYear?: unknown }>(req);
    const devices = saveNewDevice(u, {
      orgId: b.orgId,
      id: b.id ?? null,
      brand: b.brand,
      model: String(b.model ?? ""),
      series: String(b.series ?? ""),
      variant: String(b.variant ?? ""),
      price: typeof b.price === "number" ? b.price : Number.NaN,
      supportEndYear: b.supportEndYear === null || b.supportEndYear === undefined || b.supportEndYear === "" ? null : Number(b.supportEndYear),
      active: b.active,
      sourceLabel: b.sourceLabel ? String(b.sourceLabel) : undefined,
    });
    return { devices };
  });
}
