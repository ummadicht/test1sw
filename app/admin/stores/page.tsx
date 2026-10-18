import Link from "next/link";
import { requirePage } from "@/lib/server/page";
import { listStores } from "@/lib/server/admin";
import { programmeReport } from "@/lib/server/reports";
import { AppShell } from "@/components/AppShell";
import { Card, Empty, Meter, Money } from "@/components/ui";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { STORE_KIND_LABEL, fmtDay, fracPct } from "@/components/admin/format";
import { StoreLimitForm } from "./StoreLimitForm";
import { AddStoreForm } from "./AddStoreForm";
import { PendingStores } from "./PendingStores";
import { pendingStores } from "@/lib/server/signup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stores" };

export default async function AdminStoresPage({ searchParams }: { searchParams: Promise<{ orgId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/stores");
  const sp = await searchParams;
  const ctx = adminContext(u, sp.orgId);
  const intro = "Each store's trade-in credit line.";
  if (!ctx.orgId) {
    return (
      <AppShell user={u} wide>
        <AdminFrame ctx={ctx} section="/admin/stores" title="Stores" intro={intro}>
          {null}
        </AdminFrame>
      </AppShell>
    );
  }
  const orgId = ctx.orgId;
  const stores = listStores(u).filter((s) => s.org_id === orgId);
  const live = new Map(programmeReport(u, { orgId }).stores.map((r) => [r.storeId, r]));
  const totalLimit = stores.reduce((t, s) => t + s.credit_limit, 0);
  const pending = pendingStores(u).filter((p) => stores.some((s) => s.id === p.id));

  return (
    <AppShell user={u} wide>
      <AdminFrame
        ctx={ctx}
        section="/admin/stores"
        title="Stores"
        intro={intro}
        actions={
          <div className="text-right">
            <div className="section-title">Total limits</div>
            <div className="text-[22px] font-[750]">
              <Money value={totalLimit} />
            </div>
          </div>
        }
      >
        <PendingStores stores={pending} />
        <Card title={`${stores.length} store${stores.length === 1 ? "" : "s"}`} pad={false}>
          {stores.length ? (
            <div className="overflow-x-auto">
              <table className="table min-w-[860px]">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Code</th>
                    <th className="text-right">Credit limit</th>
                    <th className="w-[220px]">In use now</th>
                    <th className="text-right">Available</th>
                    <th>Change limit</th>
                  </tr>
                </thead>
                <tbody>
                  {stores.map((s) => {
                    const r = live.get(s.id);
                    return (
                      <tr key={s.id} className="align-top">
                        <td className="!align-top">
                          <Link href={`/store?storeId=${encodeURIComponent(s.id)}`} className="font-semibold">
                            {s.name}
                          </Link>
                          <div className="hint !mt-0.5">
                            {[s.city, STORE_KIND_LABEL[s.kind] ?? s.kind].filter(Boolean).join(" · ")}
                            {s.active ? "" : " · inactive"}
                          </div>
                          <div className="hint !mt-0.5">Added {fmtDay(s.created_at)}</div>
                        </td>
                        <td className="!align-top">
                          <span className="pill num">{s.code}</span>
                        </td>
                        <td className="!align-top text-right">
                          <Money value={s.credit_limit} className="text-[17px] font-bold" />
                        </td>
                        <td className="!align-top">
                          {r ? (
                            <>
                              <Meter value={r.utilisation} state={r.state} />
                              <div className="text-[13px] mt-1.5 text-ink-2">
                                <Money value={r.exposure} /> · {fracPct(r.utilisation)} · {r.waiting} device{r.waiting === 1 ? "" : "s"} waiting
                              </div>
                            </>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="!align-top text-right">
                          {r ? <Money value={r.available} className={r.available <= 0 ? "text-bad font-semibold" : ""} /> : <span className="text-muted">—</span>}
                        </td>
                        <td className="!align-top">
                          <StoreLimitForm storeId={s.id} storeName={s.name} limit={s.credit_limit} exposure={r?.exposure ?? 0} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No stores yet">Add the first one below.</Empty>
          )}
        </Card>
        <p className="hint">Every limit change is recorded with who made it, the old and new limit and your reason.</p>

        <Card title="Add a store">
          <AddStoreForm orgId={orgId} isPlatform={ctx.isPlatform} usersHref={ctx.isPlatform ? null : "/admin/users"} />
        </Card>
      </AdminFrame>
    </AppShell>
  );
}
