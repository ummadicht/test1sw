import type { ReactNode } from "react";

/** A numbered step of the counter flow, with a tick once it is complete. */
export function StepCard({
  n,
  title,
  done,
  id,
  aside,
  children,
}: {
  n: number;
  title: ReactNode;
  done?: boolean;
  id?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-28" aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <span
          className={`grid place-items-center w-8 h-8 rounded-full text-[14px] font-bold shrink-0 ${
            done ? "bg-up text-white" : "bg-surface-2 text-ink-2 border border-line"
          }`}
          aria-hidden
        >
          {n}
        </span>
        <h2 id={id ? `${id}-title` : undefined} className="text-[17px] font-[720] tracking-tight">
          {title}
        </h2>
        {done ? (
          <span className="pill pill-up" aria-label="Step complete">
            ✓ Done
          </span>
        ) : null}
        {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
      </header>
      <div className="px-5 pb-5 pt-3">{children}</div>
    </section>
  );
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
