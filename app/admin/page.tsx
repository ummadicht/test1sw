import Link from "next/link";
import type { ReactNode } from "react";
import { requirePage } from "@/lib/server/page";
import { orgSettings } from "@/lib/server/auth";
import { programmeReport, type StoreReport } from "@/lib/server/reports";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Empty, Meter, Money, Pct } from "@/components/ui";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { STORE_KIND_LABEL, fmtDay, fracPct, isIsoDate, lineState, todayIst, withOrg } from "@/components/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Programme overview" };

type SP = { orgId?: string; from?: string; to?: string };

export default async function AdminOverviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin");
  const sp = await searchParams;
  const ctx = await adminContext(u, sp.orgId);
  const from = isIsoDate(sp.from) ? sp.from : null;
  const to = isIsoDate(sp.to) ? sp.to : null;

  if (!ctx.orgId) {
    return (
      <AppShell user={u} wide>
        <AdminFrame ctx={ctx} section="/admin" title="Programme overview">
          {null}
        </AdminFrame>
      </AppShell>
    );
  }

  const report = await programmeReport(u, { orgId: ctx.orgId, from, to });
  const settings = await orgSettings(ctx.orgId);
  const t = report.totals;
  const decided = t.funnel.repairs + t.funnel.upgrades + t.funnel.walked;
  const totalState = lineState(t.limit, t.exposure, settings.warnAt);
  const dueStores = report.stores.filter((s) => s.pickupDue);

  const today = todayIst();
  const monthStart = `${today.slice(0, 8)}01`;
  const d30 = new Date(`${today}T00:00:00Z`);
  d30.setUTCDate(d30.getUTCDate() - 29);
  const last30 = d30.toISOString().slice(0, 10);
  const range = (f: string | null, tt: string | null) => withOrg("/admin", ctx.orgId, ctx.isPlatform, { from: f, to: tt });
  const rangeLabel = from || to ? `${from ? fmtDay(from) : "the start"} – ${to ? fmtDay(to) : "today"}` : "all time";

  return (
    <AppShell user={u} wide>
      <AdminFrame
        ctx={ctx}
        section="/admin"
        title="Programme overview"
        intro="Your stores' results and credit right now."
      >
        <Card pad={false}>
          <form method="get" action="/admin" className="px-5 py-4 flex flex-wrap items-end gap-3">
            {ctx.isPlatform ? <input type="hidden" name="orgId" value={ctx.orgId} /> : null}
            <label className="block">
              <span className="label">Cases opened from</span>
              <input className="input !min-h-[40px]" type="date" name="from" defaultValue={from ?? ""} max={today} />
            </label>
            <label className="block">
              <span className="label">to</span>
              <input className="input !min-h-[40px]" type="date" name="to" defaultValue={to ?? ""} max={today} />
            </label>
            <button className="btn btn-primary btn-sm !min-h-[40px]" type="submit">
              Apply
            </button>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Link className="btn btn-sm" href={range(monthStart, today)}>
                This month
              </Link>
              <Link className="btn btn-sm" href={range(last30, today)}>
                Last 30 days
              </Link>
              <Link className="btn btn-sm" href={range(null, null)}>
                All time
              </Link>
            </div>
          </form>
          <p className="hint px-5 pb-4 !mt-0">
            Showing cases opened in <strong className="text-ink-2">{rangeLabel}</strong>. Credit figures are always as of now.
          </p>
        </Card>

        {dueStores.length ? (
          <Banner tone="warn">
            <strong>
              {dueStores.length === 1 ? "1 store needs" : `${dueStores.length} stores need`} a pickup:
            </strong>{" "}
            {dueStores.map((s) => s.storeName).join(", ")}. A store that reaches its limit cannot take more trade-ins until the partner collects.
          </Banner>
        ) : null}

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Programme totals">
          <Kpi label="Trade-ins taken" value={<span className="num">{t.funnel.upgrades}</span>}>
            <Money value={t.tradeInTotal} /> in trade-in value given
          </Kpi>
          <Kpi label="Upgrade rate" value={fracPct(t.upgradeRate)} tone="up">
            {decided ? (
              <>
                {t.funnel.upgrades} of {decided} decided cases upgraded
              </>
            ) : (
              "No decided cases in this range yet"
            )}
          </Kpi>
          <Kpi label="Repairs chosen" value={<span className="num">{t.funnel.repairs}</span>} tone="fix">
            {t.funnel.walked} walked away · {t.funnel.cases} cases opened
          </Kpi>
          <Kpi label="Upgrade bonus given" value={<Money value={t.bonusTotal} />}>
            {t.avgBonusBp !== null ? (
              <>
                Average <Pct bp={t.avgBonusBp} /> per upgrade — claimable from the campaign funder
              </>
            ) : (
              "No bonuses given in this range"
            )}
          </Kpi>
          <Kpi label="New-phone sales influenced" value={<Money value={t.newDeviceRevenue} />}>
            List price of new phones sold with a trade-in
          </Kpi>
          <div className="card card-pad">
            <div className="section-title">Trade-in credit in use</div>
            <div className="kpi mt-1">
              <Money value={t.exposure} />
            </div>
            <div className="mt-3">
              <Meter value={t.utilisation} state={totalState} />
            </div>
            <div className="hint !mt-2">
              {fracPct(t.utilisation)} of <Money value={t.limit} /> across {report.stores.length} store{report.stores.length === 1 ? "" : "s"} ·{" "}
              {t.waiting} device{t.waiting === 1 ? "" : "s"} waiting
              {t.chargebacksOpen > 0 ? (
                <>
                  {" "}
                  · <Money value={t.chargebacksOpen} /> in open chargebacks
                </>
              ) : null}
            </div>
          </div>
        </section>

        <Card title="Stores" pad={false}>
          {report.stores.length ? (
            <div className="overflow-x-auto">
              <table className="table min-w-[1080px]">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th className="w-[210px]">Credit line</th>
                    <th className="text-right">Available</th>
                    <th className="text-right">Waiting</th>
                    <th>Pickup</th>
                    <th className="text-right">Open chargebacks</th>
                    <th className="text-right">Cases</th>
                    <th className="text-right">Upgrade rate</th>
                    <th className="text-right">Bonus given</th>
                  </tr>
                </thead>
                <tbody>
                  {report.stores.map((s) => (
                    <StoreRow key={s.storeId} s={s} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No stores in this programme yet">
              Add one on <Link href={withOrg("/admin/stores", ctx.orgId, ctx.isPlatform)}>Stores</Link>.
            </Empty>
          )}
        </Card>
        <p className="hint">
          Upgrade rate = upgrades ÷ (repairs + upgrades + walk-aways). Cancelled trade-ins are left out.
        </p>
      </AdminFrame>
    </AppShell>
  );
}

function Kpi({ label, value, tone, children }: { label: string; value: ReactNode; tone?: "up" | "fix"; children?: ReactNode }) {
  return (
    <div className="card card-pad">
      <div className="section-title">{label}</div>
      <div className={`kpi mt-1 ${tone === "up" ? "text-up" : tone === "fix" ? "text-fix" : ""}`}>{value}</div>
      {children ? <div className="hint mt-1">{children}</div> : null}
    </div>
  );
}

function StoreRow({ s }: { s: StoreReport }) {
  return (
    <tr>
      <td>
        <Link href={`/store?storeId=${encodeURIComponent(s.storeId)}`} className="font-semibold">
          {s.storeName}
        </Link>
        <div className="hint !mt-0.5">
          {[s.city, STORE_KIND_LABEL[s.kind] ?? s.kind].filter(Boolean).join(" · ")}
        </div>
      </td>
      <td>
        <Meter value={s.utilisation} state={s.state} />
        <div className="text-[13px] mt-1.5 text-ink-2">
          <Money value={s.exposure} /> used of <Money value={s.limit} />
        </div>
      </td>
      <td className="text-right">
        <Money value={s.available} className={s.available <= 0 ? "text-bad font-semibold" : ""} />
      </td>
      <td className="text-right">
        <span className="num">{s.waiting}</span>
        <div className="hint !mt-0.5 whitespace-nowrap">
          {s.oldestDays === null ? "none waiting" : s.oldestDays === 0 ? "oldest: today" : `oldest ${s.oldestDays} day${s.oldestDays === 1 ? "" : "s"}`}
        </div>
      </td>
      <td>
        {s.pickupDue ? (
          <span className="pill pill-warn cursor-help" title={s.pickupReasons.join("\n")}>
            Pickup due
          </span>
        ) : (
          <span className="pill" title={s.waiting ? "No pickup trigger reached yet." : "Nothing waiting at the store."}>
            Not yet
          </span>
        )}
        {s.pickupDue && s.pickupReasons[0] ? <div className="hint !mt-1 max-w-[220px]">{s.pickupReasons[0]}</div> : null}
      </td>
      <td className="text-right">
        <Money value={s.chargebacksOpen} className={s.chargebacksOpen > 0 ? "text-bad" : "text-muted"} />
      </td>
      <td className="text-right">
        <span className="num">{s.funnel.cases}</span>
        <div className="hint !mt-0.5 whitespace-nowrap">
          {s.funnel.upgrades} up · {s.funnel.repairs} repair
        </div>
      </td>
      <td className="text-right num">{fracPct(s.upgradeRate)}</td>
      <td className="text-right">
        <Money value={s.bonusTotal} />
        {s.avgBonusBp !== null ? (
          <div className="hint !mt-0.5">
            avg <Pct bp={s.avgBonusBp} />
          </div>
        ) : null}
      </td>
    </tr>
  );
}
