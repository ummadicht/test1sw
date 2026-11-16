import { requirePage } from "@/lib/server/page";
import { orgSettings, orgSettingsDefaults } from "@/lib/server/auth";
import { getIqConnectionStatus } from "@/lib/server/iqEngines";
import { AppShell } from "@/components/AppShell";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { IqConnectionConsole } from "@/components/platform/IqConnectionConsole";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Programme settings" };

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/settings");
  const sp = await searchParams;
  const ctx = await adminContext(u, sp.orgId);
  const iqStatus = await getIqConnectionStatus();
  const intro = "Credit, pickups, repair pricing and the recommendation.";
  return (
    <AppShell user={u} wide>
      <AdminFrame ctx={ctx} section="/admin/settings" title="Programme settings" intro={intro}>
        <IqConnectionConsole initial={iqStatus} />
        {ctx.orgId ? (
          <SettingsForm
            key={ctx.orgId}
            orgId={ctx.orgId}
            isPlatform={ctx.isPlatform}
            initial={await orgSettings(ctx.orgId)}
            labourDefaults={orgSettingsDefaults().repairPolicy.labourByTier}
          />
        ) : null}
      </AdminFrame>
    </AppShell>
  );
}
