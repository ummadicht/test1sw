import { requirePage } from "@/lib/server/page";
import { orgSettings, orgSettingsDefaults } from "@/lib/server/auth";
import { AppShell } from "@/components/AppShell";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Programme settings" };

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/settings");
  const sp = await searchParams;
  const ctx = adminContext(u, sp.orgId);
  const intro = "How credit lines release, when stores are told to book a pickup, how repairs are priced and how the recommendation weighs the money.";
  return (
    <AppShell user={u} wide>
      <AdminFrame ctx={ctx} section="/admin/settings" title="Programme settings" intro={intro}>
        {ctx.orgId ? (
          <SettingsForm
            key={ctx.orgId}
            orgId={ctx.orgId}
            isPlatform={ctx.isPlatform}
            initial={orgSettings(ctx.orgId)}
            labourDefaults={orgSettingsDefaults().repairPolicy.labourByTier}
          />
        ) : null}
      </AdminFrame>
    </AppShell>
  );
}
