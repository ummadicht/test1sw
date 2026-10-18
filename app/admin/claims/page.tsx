import Link from "next/link";
import { requirePage } from "@/lib/server/page";
import { bonusClaims, type BonusClaimRow } from "@/lib/server/reports";
import { caseIdsByRef } from "@/lib/server/admin-extra";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Empty, Money, Pct, StatusPill } from "@/components/ui";
import { CASE_STATUS_LABEL, type CaseStatus } from "@/lib/domain/lifecycle";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { fmtDay, fmtMonth, isMonth, monthIst, shiftMonth, withOrg } from "@/components/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bonus claims" };

const AT_RISK: Record<string, string> = {
  rejected: "Device failed the partner's check",
  not_received: "Partner says the device never arrived",
};

type Group = { fundedBy: string; count: number; sum: number; riskCount: number; riskSum: number };

export default async function AdminClaimsPage({ searchParams }: { searchParams: Promise<{ orgId?: string; month?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/claims");
  const sp = await searchParams;
  const ctx = adminContext(u, sp.orgId);
  const intro =
    "Bonuses given, to claim back from the funder.";
  if (!ctx.orgId) {
    return (
      <AppShell user={u} wide>
        <AdminFrame ctx={ctx} section="/admin/claims" title="Bonus claims" intro={intro}>
          {null}
        </AdminFrame>
      </AppShell>
    );
  }
  const orgId = ctx.orgId;
  const thisMonth = monthIst();
  const allMonths = sp.month === "all";
  const month = allMonths ? null : isMonth(sp.month) ? sp.month : thisMonth;
  const rows = bonusClaims(u, { orgId, month });
  const ids = caseIdsByRef(u, rows.map((r) => r.caseRef));

  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = r.fundedBy || "Not recorded";
    const g = groups.get(key) ?? { fundedBy: key, count: 0, sum: 0, riskCount: 0, riskSum: 0 };
    g.count += 1;
    g.sum += r.bonus;
    if (AT_RISK[r.status]) {
      g.riskCount += 1;
      g.riskSum += r.bonus;
    }
    groups.set(key, g);
  }
  const total = rows.reduce((t, r) => t + r.bonus, 0);
  const risk = rows.filter((r) => AT_RISK[r.status]);

  const link = (m: string) => withOrg("/admin/claims", orgId, ctx.isPlatform, { month: m });
  const csv = withOrg("/api/reports/bonus-claims.csv", orgId, ctx.isPlatform, { month: month ?? undefined });
  const periodLabel = month ? fmtMonth(month) : "all months";

  return (
    <AppShell user={u} wide>
      <AdminFrame
        ctx={ctx}
        section="/admin/claims"
        title="Bonus claims"
        intro={intro}
        actions={
          <a className="btn btn-primary" href={csv} download>
            ⤓ Download CSV
          </a>
        }
      >
        <Card pad={false}>
          <div className="px-5 py-4 flex flex-wrap items-end gap-3">
            <form method="get" action="/admin/claims" className="flex flex-wrap items-end gap-3">
              {ctx.isPlatform ? <input type="hidden" name="orgId" value={orgId} /> : null}
              <label className="block">
                <span className="label">Month</span>
                <input className="input !min-h-[40px]" type="month" name="month" defaultValue={month ?? ""} max={thisMonth} />
              </label>
              <button className="btn btn-primary btn-sm !min-h-[40px]">Show</button>
            </form>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Link className="btn btn-sm" href={link(shiftMonth(month ?? thisMonth, -1))}>
                ← {fmtMonth(shiftMonth(month ?? thisMonth, -1))}
              </Link>
              {month && month < thisMonth ? (
                <Link className="btn btn-sm" href={link(shiftMonth(month, 1))}>
                  {fmtMonth(shiftMonth(month, 1))} →
                </Link>
              ) : null}
              <Link className="btn btn-sm" href={link(thisMonth)} aria-current={month === thisMonth ? "page" : undefined}>
                This month
              </Link>
              <Link className="btn btn-sm" href={link("all")} aria-current={allMonths ? "page" : undefined}>
                All months
              </Link>
            </div>
          </div>
        </Card>

        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Totals">
          <div className="card card-pad">
            <div className="section-title">Bonuses given · {periodLabel}</div>
            <div className="kpi mt-1">
              <Money value={total} />
            </div>
            <div className="hint mt-1">
              {rows.length} upgrade{rows.length === 1 ? "" : "s"} with a bonus
            </div>
          </div>
          {[...groups.values()].map((g) => (
            <div key={g.fundedBy} className="card card-pad">
              <div className="section-title">Funded by</div>
              <div className="text-[16px] font-semibold mt-1">{g.fundedBy}</div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="kpi !text-[24px]">
                  <Money value={g.sum} />
                </span>
                <span className="text-ink-2 text-[14px]">
                  {g.count} claim{g.count === 1 ? "" : "s"}
                </span>
              </div>
              {g.riskCount ? (
                <div className="hint mt-1 !text-[color:var(--bad)]">
                  {g.riskCount} at risk (<Money value={g.riskSum} />)
                </div>
              ) : null}
            </div>
          ))}
        </section>

        {risk.length ? (
          <Banner tone="bad">
            <strong>
              {risk.length} claim{risk.length === 1 ? " is" : "s are"} at risk
            </strong>{" "}
            (<Money value={risk.reduce((t, r) => t + r.bonus, 0)} />): rejected or not received — check before claiming.
          </Banner>
        ) : null}

        <Card title={`Claims · ${periodLabel}`} pad={false}>
          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="table min-w-[980px]">
                <thead>
                  <tr>
                    <th>Case · traded in</th>
                    <th>Store</th>
                    <th>New phone</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Trade-in</th>
                    <th className="text-right">Bonus</th>
                    <th>Campaign</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ClaimRow key={r.caseRef} r={r} caseId={ids[r.caseRef]} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={`No upgrade bonuses in ${periodLabel}`}>
              {month ? (
                <>
                  Try <Link href={link("all")}>all months</Link>.
                </>
              ) : (
                "None of this programme's trade-ins has had a bonus yet."
              )}
            </Empty>
          )}
        </Card>
        <p className="hint">The CSV adds status and at-risk notes. Cancelled trade-ins are left out.</p>
      </AdminFrame>
    </AppShell>
  );
}

function ClaimRow({ r, caseId }: { r: BonusClaimRow; caseId: string | undefined }) {
  const risk = AT_RISK[r.status];
  return (
    <tr className={risk ? "bg-bad-bg/40" : ""}>
      <td className="whitespace-nowrap">
        {caseId ? (
          <Link href={`/cases/${encodeURIComponent(caseId)}`} className="num font-semibold">
            {r.caseRef}
          </Link>
        ) : (
          <span className="num font-semibold">{r.caseRef}</span>
        )}
        <div className="hint !mt-0.5">{fmtDay(r.lockedAt)}</div>
      </td>
      <td className="max-w-[200px]">{r.storeName}</td>
      <td className="max-w-[200px]">{r.newDevice || "—"}</td>
      <td className="text-right">
        <Money value={r.newPrice} />
      </td>
      <td className="text-right">
        <Money value={r.tradeValue} />
      </td>
      <td className="text-right">
        <Money value={r.bonus} className="font-semibold text-up" />
        <div className="hint !mt-0.5">
          <Pct bp={r.bonusBp} />
        </div>
      </td>
      <td className="max-w-[240px]">
        {r.campaign || "—"}
        {r.override ? (
          <div className="text-[12.5px] text-warn mt-0.5" title="Bonus % changed by a manager at the counter">
            Override — {r.override}
          </div>
        ) : null}
      </td>
      <td>
        <StatusPill status={r.status} label={CASE_STATUS_LABEL[r.status as CaseStatus] ?? r.status} />
        {risk ? (
          <div className="text-[12.5px] text-bad font-semibold mt-1 max-w-[200px]">
            Claim at risk: {risk.charAt(0).toLowerCase() + risk.slice(1)}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
