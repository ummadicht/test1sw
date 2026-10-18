import Link from "next/link";
import type { CaseListItem } from "@/lib/server/cases";
import { Money, StatusPill, Empty } from "@/components/ui";
import { CASE_STATUS_LABEL } from "@/lib/domain/lifecycle";
import { recommendationOf, fmtWhen } from "./shared";

/** One line per case: who, which phone, what we'd recommend, what the trade-in is worth. */
export function CaseRows({
  cases,
  empty,
  emptyHint,
  mode,
}: {
  cases: CaseListItem[];
  empty: string;
  emptyHint?: string;
  mode: "counter" | "held";
}) {
  if (!cases.length) return <Empty title={empty}>{emptyHint}</Empty>;
  const now = Date.now();
  return (
    <ul className="divide-y divide-[color:var(--line)]">
      {cases.map((c) => {
        const rec = recommendationOf(c.recommendation);
        const days = c.lockedAt ? Math.floor((now - Date.parse(c.lockedAt)) / 86_400_000) : null;
        return (
          <li key={c.id}>
            <Link href={`/cases/${c.id}`} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5 no-underline hover:bg-[color:var(--surface-2)]">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[15.5px] font-semibold truncate">{c.customerName || "No name yet"}</span>
                  <span className="num text-[12px] text-muted shrink-0">{c.ref}</span>
                </div>
                <div className="text-[13.5px] text-ink-2 truncate">
                  {c.device ?? <span className="text-muted">No phone yet</span>}
                  {mode === "held" && c.newDevice ? <span className="text-muted"> → {c.newDevice}</span> : null}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {mode === "counter" ? (
                  rec ? <span className={`pill ${rec.pill}`}>{rec.label}</span> : null
                ) : (
                  <StatusPill status={c.status} label={CASE_STATUS_LABEL[c.status]} />
                )}
              </div>
              <div className="ml-auto text-right shrink-0">
                <div className="flex items-center justify-end gap-2">
                  <Money value={c.tradeValue} className="text-[17px] font-bold" />
                </div>
                <div className="text-[12px] text-muted">
                  {mode === "held"
                    ? days === null
                      ? "trade-in"
                      : days === 0
                        ? "traded in today"
                        : `waiting ${days} day${days === 1 ? "" : "s"}`
                    : `trade-in · ${fmtWhen(c.updatedAt)}`}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
