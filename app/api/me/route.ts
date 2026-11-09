import { handle } from "@/lib/server/http";
import { requireUser, homeFor, ROLE_LABEL } from "@/lib/server/auth";
import { getOrg, getStore } from "@/lib/server/scope";

export async function GET() {
  return handle(async () => {
    const u = await requireUser();
    const org = await getOrg(u.orgId);
    const store = u.storeId ? await getStore(u.storeId) : null;
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      roleLabel: ROLE_LABEL[u.role],
      home: homeFor(u.role),
      org: org ? { id: org.id, name: org.name, kind: org.kind, demo: !!org.demo } : null,
      store: store ? { id: store.id, name: store.name, code: store.code, kind: store.kind, city: store.city, status: store.status ?? "active", reviewNote: store.review_note ?? null } : null,
    };
  });
}
