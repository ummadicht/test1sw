import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { TeamManager } from "@/components/TeamManager";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { requirePage } from "@/lib/server/page";
import { listStores, listUsers } from "@/lib/server/admin";
import type { Role } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

/** A programme admin may create programme admins, store managers and advisors (admin.ts mayCreate). */
const ADMIN_ROLES: Role[] = ["advisor", "store_manager", "org_admin"];

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/users");
  const sp = await searchParams;
  const ctx = adminContext(u, sp.orgId);
  const intro = "Who can sign in to this programme. Programme admins see every store; store managers and advisors work at one.";
  if (!ctx.orgId) {
    return (
      <AppShell user={u}>
        <AdminFrame ctx={ctx} section="/admin/users" title="Users" intro={intro}>
          {null}
        </AdminFrame>
      </AppShell>
    );
  }
  const orgId = ctx.orgId;
  const users = listUsers(u).filter((x) => x.orgId === orgId);
  const stores = listStores(u)
    .filter((s) => s.org_id === orgId)
    .map((s) => ({ id: s.id, name: s.name, orgId: s.org_id }));
  const storesHref = ctx.isPlatform ? `/admin/stores?orgId=${encodeURIComponent(orgId)}` : "/admin/stores";

  return (
    <AppShell user={u}>
      <AdminFrame ctx={ctx} section="/admin/users" title="Users" intro={intro}>
        <TeamManager
          title="Users"
          showTitle={false}
          users={users}
          canCreateRoles={ADMIN_ROLES}
          stores={stores}
          meId={u.id}
          fixedOrgId={orgId}
          addStoreHref={storesHref}
          intro={
            stores.length === 0 ? (
              <>
                This programme has no stores yet —{" "}
                <Link href={storesHref} className="font-semibold">
                  add a store
                </Link>{" "}
                before adding store managers and advisors.
              </>
            ) : (
              <>Store managers can also add advisors for their own store from their Team page.</>
            )
          }
        />
      </AdminFrame>
    </AppShell>
  );
}
