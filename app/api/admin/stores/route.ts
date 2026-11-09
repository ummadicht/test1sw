import { handle, body } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { listStores, createStore } from "@/lib/server/admin";
import { adminOrgId } from "@/lib/server/scope";

/** Stores in the programme. Platform passes ?orgId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const orgId = await adminOrgId(u, new URL(req.url).searchParams.get("orgId"));
    return { stores: (await listStores(u)).filter((s) => s.org_id === orgId) };
  });
}

/** Add a store: { orgId?, name, kind, city?, code, creditLimit }. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<{ orgId?: string; name?: string; kind?: string; city?: string; code?: string; creditLimit?: unknown }>(req);
    const store = await createStore(u, {
      orgId: b.orgId,
      name: String(b.name ?? ""),
      kind: String(b.kind ?? ""),
      city: b.city ? String(b.city) : undefined,
      code: String(b.code ?? ""),
      creditLimit: typeof b.creditLimit === "number" ? b.creditLimit : Number.NaN,
    });
    return { store };
  });
}
