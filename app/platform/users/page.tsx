import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { TeamManager } from "@/components/TeamManager";
import { requirePage } from "@/lib/server/page";
import { listOrgs, listStores, listUsers } from "@/lib/server/admin";
import type { Role } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

const ROLES_FOR_KIND: Record<"platform" | "client" | "partner", Role[]> = {
  client: ["advisor", "store_manager", "org_admin"],
  partner: ["partner"],
  platform: ["platform"],
};

/** Every account on SwapUp. Platform staff may create any role (admin.ts mayCreate), in the right kind of org. */
export default async function PlatformUsersPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["platform"], "/platform/users");
  const { orgId } = await searchParams;
  const orgs = await listOrgs(u);
  const org = orgId ? orgs.find((o) => o.id === orgId) ?? null : null;
  const all = await listUsers(u);
  const users = org ? all.filter((x) => x.orgId === org.id) : all;
  const stores = (await listStores(u)).map((s) => ({ id: s.id, name: s.name, orgId: s.org_id }));
  const countFor = (id: string) => all.filter((x) => x.orgId === id).length;
  const kindOrder = { client: 0, partner: 1, platform: 2 } as const;
  const sorted = [...orgs].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));

  return (
    <AppShell user={u}>
      <nav aria-label="Filter by organisation" className="mb-5 -mx-4 px-4 sm:mx-0 sm:px-0 flex gap-2 overflow-x-auto sm:flex-wrap pb-1">
        <Link href="/platform/users" className={`chip no-underline shrink-0 ${!org ? "on" : ""}`} aria-current={!org ? "page" : undefined}>
          Everyone <span className="num text-[13px] opacity-70">{all.length}</span>
        </Link>
        {sorted.map((o) => (
          <Link key={o.id} href={`/platform/users?orgId=${encodeURIComponent(o.id)}`} className={`chip no-underline shrink-0 ${org?.id === o.id ? "on" : ""}`}
            aria-current={org?.id === o.id ? "page" : undefined}
          >
            {o.name} <span className="num text-[13px] opacity-70">{countFor(o.id)}</span>
          </Link>
        ))}
      </nav>
      {orgId && !org ? (
        <div className="banner banner-warn mb-4">
          <span aria-hidden>⚠</span>
          <div>That organisation was not found — showing everyone.</div>
        </div>
      ) : null}
      <TeamManager
        title={org ? `People at ${org.name}` : "Everyone on SwapUp"}
        users={users}
        canCreateRoles={org ? ROLES_FOR_KIND[org.kind] : ["advisor", "store_manager", "org_admin", "partner", "platform"]}
        stores={stores}
        orgs={orgs.map((o) => ({ id: o.id, name: o.name, kind: o.kind }))}
        showOrg={!org}
        meId={u.id}
        fixedOrgId={org?.id ?? null}
        addStoreHref="/admin/stores?orgId={orgId}"
        intro={
          org?.kind === "client" ? (
            <>
              Programme admins run the whole programme; store managers and advisors work at one store.{" "}
              <Link href={`/admin/stores?orgId=${encodeURIComponent(org.id)}`} className="font-semibold">
                Stores for this client →
              </Link>
            </>
          ) : org?.kind === "partner" ? (
            <>Partner accounts: pickups, verdicts, settlement, rate cards.</>
          ) : org?.kind === "platform" ? (
            <>Platform accounts see every programme — keep it short.</>
          ) : (
            <>Every account. Pick an organisation to narrow.</>
          )
        }
      />
    </AppShell>
  );
}
