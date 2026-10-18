import Link from "next/link";
import { requirePage } from "@/lib/server/page";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import { HttpError } from "@/lib/server/auth";
import { AppShell } from "@/components/AppShell";
import { Card, Empty } from "@/components/ui";
import { getTradeModel, type CaseView } from "@/lib/server/cases";
import { tradeBrands, activeCampaigns } from "@/lib/server/catalog";
import { getPickup } from "@/lib/server/pickups";
import { parseJson } from "@/lib/server/db";
import { CaseWorkspace } from "@/components/counter/CaseWorkspace";
import type { CampaignBand, ModelOption, PickupInfo } from "@/components/counter/ops";

export const dynamic = "force-dynamic";
export const metadata = { title: "Case" };

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string | string[] }> }) {
  const { id } = await params;
  // ?view=answer — the store app's hand-off: the answer first, the steps folded away.
  const answerFirst = (await searchParams).view === "answer";
  const u = await requirePage(null, `/cases/${id}${answerFirst ? "?view=answer" : ""}`);

  let view: CaseView;
  try {
    view = getCaseForViewer(u, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return (
        <AppShell user={u}>
          <Card>
            <Empty title="Case not found">
              Wrong link, or another store&apos;s case.{" "}
              <Link href={u.role === "advisor" || u.role === "store_manager" ? "/desk" : "/cases"}>Back</Link>
            </Empty>
          </Card>
        </AppShell>
      );
    }
    throw e;
  }

  const tm = view.device ? getTradeModel(view.device.modelId) : null;
  const initialModel: ModelOption | null = tm
    ? {
        id: tm.id,
        brand: tm.brand,
        model: tm.model,
        series: tm.series,
        releaseYear: tm.release_year,
        supportEndYear: tm.support_end_year,
        variants: parseJson<string[]>(tm.variants, []),
      }
    : null;

  // Campaign bands, so a manager changing the bonus sees the limits before the server refuses.
  const bands: Record<string, CampaignBand> = {};
  if (u.role === "store_manager") {
    for (const c of activeCampaigns(view.orgId)) bands[c.id] = { name: c.name, minBp: c.minBp, maxBp: c.maxBp, capRupees: c.capRupees };
  }

  let pickup: PickupInfo | null = null;
  if (view.pickupId) {
    try {
      const p = getPickup(u, view.pickupId);
      pickup = { ref: p.ref, status: p.status, collectedAt: p.collectedAt, collectorName: p.collectorName, settledAt: p.settledAt };
    } catch {
      pickup = null; // out of this user's scope — the case still shows
    }
  }

  return (
    <AppShell user={u} wide>
      <CaseWorkspace initial={view} role={u.role} brands={tradeBrands()} initialModel={initialModel} bands={bands} pickup={pickup} answerFirst={answerFirst} />
    </AppShell>
  );
}
