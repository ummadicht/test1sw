import { AppShell } from "@/components/AppShell";
import { TeamManager } from "@/components/TeamManager";
import { requirePage } from "@/lib/server/page";
import { listUsers } from "@/lib/server/admin";
import { getStore } from "@/lib/server/scope";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

/** A store manager adds and manages the advisors at their own store (admin.ts mayCreate: advisor only). */
export default async function StoreTeamPage() {
  const u = await requirePage(["store_manager"], "/store/team");
  const store = u.storeId ? getStore(u.storeId) : null;
  const users = listUsers(u);
  return (
    <AppShell user={u}>
      <TeamManager
        title={store ? `Team at ${store.name}` : "Team"}
        users={users}
        canCreateRoles={["advisor"]}
        stores={store ? [{ id: store.id, name: store.name, orgId: store.org_id }] : []}
        meId={u.id}
        fixedOrgId={u.orgId}
        intro={<>You can add counter advisors, reset their passwords and deactivate them. Store managers are added by your programme admin.</>}
      />
    </AppShell>
  );
}
