import { Children, type ReactNode } from "react";

/**
 * ONE STEP of the case, shown alone (CaseWorkspace, caseSteps.ts): its question,
 * its one figure, ONE line, the controls that answer it — and everything else
 * behind "Show details", closed by default. The step's number is in the progress
 * header above it ("Step 2 of 3 · What's wrong", or "The answer › Repair quote"), not here.
 */
export function StepCard({
  id,
  title,
  figure,
  line,
  lineTone = "plain",
  details,
  children,
}: {
  id: string;
  /** The step's question, or its name ("Repair quote"). */
  title: ReactNode;
  /** The step's one figure (or what is said instead of one). */
  figure?: ReactNode;
  /** ONE line under it. */
  line?: ReactNode;
  lineTone?: "plain" | "warn";
  /** Everything else — closed until "Show details". */
  details?: ReactNode;
  children?: ReactNode;
}) {
  const tone = lineTone === "warn" ? "text-warn font-semibold" : "text-ink-2";
  return (
    <section id={id} className="card scroll-mt-28" aria-labelledby={`${id}-title`}>
      <div className="px-4 sm:px-5 pt-4 pb-5">
        <h2 id={`${id}-title`} tabIndex={-1} className="text-[20px] sm:text-[22px] font-[760] tracking-tight leading-tight outline-none">
          {title}
        </h2>
        {figure ? <div className="mt-2">{figure}</div> : null}
        {line ? <p className={`text-[14px] leading-snug mt-1 ${tone}`}>{line}</p> : null}
        {Children.toArray(children).length ? <div className="mt-4 space-y-5">{children}</div> : null}
        {details ? <ShowDetails step={id}>{details}</ShowDetails> : null}
      </div>
    </section>
  );
}

/** The step's one "Show details" — closed by default, "Hide details" once open. */
function ShowDetails({ step, children }: { step: string; children: ReactNode }) {
  return (
    <details className="group mt-5 border-t border-line pt-3" data-details={step}>
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-flex items-center gap-1.5 min-h-[36px] text-[14px] font-semibold text-fix no-print">
        <span className="group-open:hidden">Show details</span>
        <span className="hidden group-open:inline">Hide details</span>
        <span aria-hidden className="inline-block group-open:rotate-90 transition-transform">
          ›
        </span>
      </summary>
      <div className="mt-3 space-y-5">{children}</div>
    </details>
  );
}

/** The step's big number. */
export function StepFigure({ children, tone }: { children: ReactNode; tone?: "fix" | "muted" }) {
  const cls = tone === "fix" ? "text-fix" : tone === "muted" ? "text-muted" : "";
  return <div className={`num text-[34px] sm:text-[40px] font-[780] leading-none tracking-tight [overflow-wrap:anywhere] ${cls}`}>{children}</div>;
}

/** What a step says instead of a figure: "Needs the service centre's quote". */
export function StepNoFigure({ children }: { children: ReactNode }) {
  return <div className="text-[19px] sm:text-[21px] font-[720] leading-snug">{children}</div>;
}

/** A labelled group of chips. */
export function ChipGroup({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
