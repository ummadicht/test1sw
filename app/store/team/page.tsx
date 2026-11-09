import { AppShell } from "@/components/AppShell";
import { TeamManager } from "@/components/TeamManager";
import { InviteStaff } from "@/components/InviteStaff";
import { requirePage } from "@/lib/server/page";
import { listUsers } from "@/lib/server/admin";
import { getStore } from "@/lib/server/scope";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

/** A store manager adds and manages the advisors at their own store (admin.ts mayCreate: advisor only). */
export default async function StoreTeamPage() {
  const u = await requirePage(["store_manager"], "/store/team");
  const store = u.storeId ? await getStore(u.storeId) : null;
  const users = await listUsers(u);
  return (
    <AppShell user={u}>
      {store ? <InviteStaff storeId={store.id} storeName={store.name} /> : null}
      <TeamManager
        title={store ? `Team at ${store.name}` : "Team"}
        users={users}
        canCreateRoles={["advisor"]}
        stores={store ? [{ id: store.id, name: store.name, orgId: store.org_id }] : []}
        meId={u.id}
        fixedOrgId={u.orgId}
        intro={<>Add, reset and deactivate advisors.</>}
      />
    </AppShell>
  );
}
