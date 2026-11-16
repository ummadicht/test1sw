import { redirect } from "next/navigation";
import { getSession, homeFor, type Role, type SessionUser } from "./auth";
import { ensureSeeded } from "./seed";
import { syncIqEnvFromDb } from "./iqEngines";

/**
 * Gate a page SERVER-side. Relying on a client redirect alone paints the page
 * (and fetches its data) before bouncing.
 */
export async function requirePage(roles: Role[] | null, here: string): Promise<SessionUser> {
  await ensureSeeded();
  await syncIqEnvFromDb();
  const u = await getSession();
  if (!u) redirect(`/login?next=${encodeURIComponent(here)}`);
  if (roles && !roles.includes(u.role)) redirect(homeFor(u.role));
  return u;
}
