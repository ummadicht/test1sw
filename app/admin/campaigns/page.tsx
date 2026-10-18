import { requirePage } from "@/lib/server/page";
import { orgSettings } from "@/lib/server/auth";
import { campaigns, newDevices, tradeBrands } from "@/lib/server/catalog";
import { listStores } from "@/lib/server/admin";
import { AppShell } from "@/components/AppShell";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { bandText } from "@/components/admin/campaignDraft";
import { todayIst } from "@/components/admin/format";
import { CampaignsConsole } from "./CampaignsConsole";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upgrade bonus" };

export default async function AdminCampaignsPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/campaigns");
  const sp = await searchParams;
  const ctx = adminContext(u, sp.orgId);
  const title = "Upgrade bonus";
  if (!ctx.orgId) {
    return (
      <AppShell user={u} wide>
        <AdminFrame ctx={ctx} section="/admin/campaigns" title={title}>
          {null}
        </AdminFrame>
      </AppShell>
    );
  }
  const orgId = ctx.orgId;
  const s = orgSettings(orgId);
  const band = { minBp: s.bandMinBp, maxBp: s.bandMaxBp };
  const phones = newDevices(orgId).map((d) => ({ id: d.id, label: `${d.model} ${d.variant}`, price: d.price, series: d.series }));
  const stores = listStores(u).filter((x) => x.org_id === orgId);
  const kindCount = new Map<string, number>();
  for (const st of stores) kindCount.set(st.kind, (kindCount.get(st.kind) ?? 0) + 1);
  const defaultStoreKind = [...kindCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "service_center";

  return (
    <AppShell user={u} wide>
      <AdminFrame
        ctx={ctx}
        section="/admin/campaigns"
        title={title}
        intro={
          <>
            Upgrades get trade-in <em>plus</em> a {bandText(band.minBp, band.maxBp)} bonus — never a reason to upgrade.
          </>
        }
      >
        <CampaignsConsole
          orgId={orgId}
          isPlatform={ctx.isPlatform}
          initial={campaigns(orgId)}
          band={band}
          brands={tradeBrands()}
          phones={phones}
          defaultStoreKind={defaultStoreKind}
          today={todayIst()}
        />
      </AdminFrame>
    </AppShell>
  );
}
