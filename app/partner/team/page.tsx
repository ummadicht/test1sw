import { AppShell } from "@/components/AppShell";
import { TeamManager } from "@/components/TeamManager";
import { requirePage } from "@/lib/server/page";
import { listUsers } from "@/lib/server/admin";
import { getOrg } from "@/lib/server/scope";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

/** The buyback partner's operations team (admin.ts mayCreate: partner only). */
export default async function PartnerTeamPage() {
  const u = await requirePage(["partner"], "/partner/team");
  const org = getOrg(u.orgId);
  return (
    <AppShell user={u}>
      <TeamManager
        title={org ? `${org.name} team` : "Team"}
        users={listUsers(u)}
        canCreateRoles={["partner"]}
        stores={[]}
        meId={u.id}
        fixedOrgId={u.orgId}
        intro={<>Your pickup and rate-card team.</>}
      />
    </AppShell>
  );
}
