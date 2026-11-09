import type { SessionUser } from "@/lib/server/auth";
import { getOrg } from "@/lib/server/scope";
import { clientOrgs } from "@/lib/server/admin-extra";

/**
 * SERVER ONLY — which client programme an admin page is looking at.
 *
 * An org_admin always sees their own organisation (any ?orgId= is ignored).
 * Platform staff have no programme of their own, so every /admin page reads
 * ?orgId= and, when it is missing or not a client, shows a picker instead.
 */
export type AdminCtx = {
  isPlatform: boolean;
  orgId: string | null;
  orgName: string;
  demo: boolean;
  clients: { id: string; name: string; demo: boolean }[];
  /** A platform user asked for an org that is not a client. */
  badOrg: boolean;
};

export async function adminContext(u: SessionUser, requested?: string | string[] | null): Promise<AdminCtx> {
  const req = Array.isArray(requested) ? requested[0] : requested;
  if (u.role === "platform") {
    const clients = await clientOrgs(u);
    const hit = req ? clients.find((c) => c.id === req) : undefined;
    return { isPlatform: true, orgId: hit?.id ?? null, orgName: hit?.name ?? "", demo: !!hit?.demo, clients, badOrg: !!req && !hit };
  }
  const org = await getOrg(u.orgId);
  return { isPlatform: false, orgId: u.orgId, orgName: org?.name ?? "", demo: !!org?.demo, clients: [], badOrg: false };
}
