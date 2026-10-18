import type { PickupView } from "@/lib/server/pickups";
import type { PickupStatus } from "@/lib/domain/lifecycle";
import { fmtWhen } from "./format";

const ORDER: Record<Exclude<PickupStatus, "cancelled">, number> = {
  requested: 0,
  scheduled: 1,
  collected: 2,
  reconciled: 3,
  settled: 4,
};

type Step = { label: string; at: string | null; sub: string | null };

/**
 * Requested → Scheduled → Collected → Verified → Settled, with the moment each
 * step happened. A pickup can be collected without a booked slot; that step
 * then says so instead of pretending it happened.
 */
export function PickupTimeline({ p }: { p: PickupView }) {
  const cancelled = p.status === "cancelled";
  const reached = p.status === "cancelled" ? 0 : ORDER[p.status];
  const steps: Step[] = [
    { label: "Requested", at: p.requestedAt, sub: p.requestedBy ? `by ${p.requestedBy}` : null },
    {
      label: "Scheduled",
      at: p.scheduledFor,
      sub: p.scheduledFor ? (p.collectorName ? `collector ${p.collectorName}` : null) : reached >= 2 ? "No booked slot" : null,
    },
    { label: "Collected", at: p.collectedAt, sub: p.handoverBy ? `handed over by ${p.handoverBy}` : null },
    {
      label: "Verified",
      at: p.reconciledAt,
      sub: reached === 2 ? `${p.totals.verified} of ${p.totals.devices} checked` : reached > 2 ? "every phone has a verdict" : null,
    },
    { label: "Settled", at: p.settledAt, sub: p.settlementRef ? `ref ${p.settlementRef}` : null },
  ];
  return (
    <ol className="grid grid-cols-1 sm:grid-cols-5 gap-2 sm:gap-0" aria-label="Pickup progress">
      {steps.map((s, i) => {
        const done = cancelled ? i === 0 : i <= reached && (i !== 1 || !!p.scheduledFor);
        const skipped = !cancelled && i === 1 && !p.scheduledFor && reached >= 2;
        const current = !cancelled && i === reached + 1;
        const dot = done ? "bg-up border-up text-white" : current ? "bg-surface border-ink text-ink" : "bg-surface border-line text-muted";
        return (
          <li key={s.label} className="flex sm:flex-col items-start gap-3 sm:gap-2 sm:pr-3 relative">
            <div className="flex sm:w-full items-center">
              <span
                className={`grid place-items-center w-7 h-7 shrink-0 rounded-full border-2 text-[12px] font-bold ${dot}`}
                aria-hidden
              >
                {done ? "✓" : skipped ? "–" : i + 1}
              </span>
              {i < steps.length - 1 ? (
                <span className={`hidden sm:block h-[2px] flex-1 ml-2 ${!cancelled && i < reached ? "bg-up" : "bg-[color:var(--line)]"}`} aria-hidden />
              ) : null}
            </div>
            <div className="min-w-0">
              <div className={`text-[14px] font-semibold ${done || current ? "" : "text-muted"}`}>
                {s.label}
                <span className="sr-only">{done ? " (done)" : current ? " (next)" : skipped ? " (skipped)" : ""}</span>
              </div>
              <div className="text-[12.5px] text-ink-2">{done && s.at ? fmtWhen(s.at) : current ? "Next" : skipped ? "Skipped" : ""}</div>
              {s.sub && (done || skipped || (i === 3 && reached === 2)) ? <div className="text-[12px] text-muted">{s.sub}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
