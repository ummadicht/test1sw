import Link from "next/link";
import { Money, SourceBadge, StatusPill } from "@/components/ui";
import { fmtWhen } from "@/components/pickups/format";
import { recommendationOf } from "@/components/counter/shared";
import { CASE_STATUS_LABEL } from "@/lib/domain/lifecycle";
import { maskImei } from "@/lib/domain/imei";
import type { CaseListItem } from "@/lib/server/cases";

/** The shared case list: one row per case, newest activity first. Server-rendered. */
export function CasesListTable({
  cases,
  showStore,
  partnerView = false,
  samples,
}: {
  cases: CaseListItem[];
  showStore: boolean;
  /** The buyback partner does not need the counter's recommendation or the new phone sold. */
  partnerView?: boolean;
  /** ids whose trade-in figure comes from a SAMPLE rate card */
  samples: string[];
}) {
  const sample = new Set(samples);
  return (
    <div className="overflow-x-auto">
      <table className={`table ${partnerView ? "min-w-[720px]" : "min-w-[920px]"}`}>
        <thead>
          <tr>
            <th>Case</th>
            {showStore ? <th>Store</th> : null}
            <th>Customer</th>
            <th>Phone</th>
            {partnerView ? null : <th>Recommended</th>}
            <th className="text-right!">Trade-in</th>
            {partnerView ? null : <th>New phone</th>}
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const rec = recommendationOf(c.recommendation);
            return (
              <tr key={c.id}>
                <td>
                  <Link href={`/cases/${c.id}`} className="font-semibold num hover:underline whitespace-nowrap">
                    {c.ref}
                  </Link>
                </td>
                {showStore ? <td className="text-[13.5px]">{c.storeName}</td> : null}
                <td>{c.customerName ?? <span className="text-muted">Not named yet</span>}</td>
                <td>
                  <div className="font-medium">{c.device ?? <span className="text-muted">Not recorded yet</span>}</div>
                  {c.imei ? <div className="text-[12px] text-muted num">IMEI {maskImei(c.imei)}</div> : null}
                </td>
                {partnerView ? null : <td>{rec ? <span className={`pill ${rec.pill}`}>{rec.label}</span> : <span className="text-muted">—</span>}</td>}
                <td className="text-right">
                  <div className="flex flex-col items-end gap-1">
                    <Money value={c.tradeValue} className="font-semibold" />
                    {c.tradeValue !== null && sample.has(c.id) ? <SourceBadge kind="sample" /> : null}
                  </div>
                </td>
                {partnerView ? null : <td className="text-[13.5px]">{c.newDevice ?? <span className="text-muted">—</span>}</td>}
                <td>
                  <StatusPill status={c.status} label={CASE_STATUS_LABEL[c.status]} />
                </td>
                <td className="whitespace-nowrap text-[13px] text-ink-2">{fmtWhen(c.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
