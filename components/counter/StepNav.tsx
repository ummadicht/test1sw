"use client";

import { useEffect, useRef, useState } from "react";
import { STEP_TITLE, neighbours, progressLabel, type StepId } from "./caseSteps";

/**
 * "Step 2 of 3 · What's wrong" (an answer page: "The answer › Repair quote"), with a bar per
 * step — tap it for the list of steps, and tap one to go there. A tick marks a step that is answered.
 */
export function StepHeader({ steps, current, done, busy, onGo }: { steps: StepId[]; current: StepId; done: (id: StepId) => boolean; busy: boolean; onGo: (id: StepId) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // An answer page (Repair quote, Trade-in) sits on the answer's bar.
  const at = steps.includes(current) ? steps.indexOf(current) : steps.indexOf("answer");

  // Close the list on a tap outside it, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <nav aria-label="Steps" className="relative mb-4 no-print" ref={box}>
      <button
        type="button"
        className="w-full flex items-center gap-3 text-left rounded-[12px] px-1 py-1.5 hover:bg-surface-2"
        aria-expanded={open}
        aria-controls="step-list"
        onClick={() => setOpen((o) => !o)}
        data-progress={progressLabel(steps, current)}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink-2" aria-live="polite">
            {progressLabel(steps, current)}
            {busy ? <span className="text-muted font-normal"> · saving…</span> : null}
          </span>
          <span className="flex gap-1 mt-1.5" aria-hidden>
            {steps.map((s, i) => (
              <span key={s} className={`h-1.5 flex-1 rounded-full ${i === at ? "bg-ink" : done(s) ? "bg-up" : "bg-[color:var(--line-2)]"}`} />
            ))}
          </span>
        </span>
        <span className="text-[13px] font-semibold text-fix shrink-0">
          All steps <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        </span>
      </button>
      {open ? (
        <ol id="step-list" className="card absolute left-0 right-0 top-full mt-1 z-30 py-1.5">
          {steps.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`w-full flex items-center gap-3 px-4 min-h-[48px] text-left hover:bg-surface-2 ${s === current ? "font-[720]" : ""}`}
                aria-current={s === current ? "step" : undefined}
                onClick={() => {
                  setOpen(false);
                  onGo(s);
                }}
              >
                <span
                  className={`grid place-items-center w-7 h-7 rounded-full text-[13px] font-bold shrink-0 ${done(s) ? "bg-up text-white" : s === current ? "bg-ink text-white" : "bg-surface-2 text-ink-2 border border-line"}`}
                  aria-hidden
                >
                  {done(s) ? "✓" : i + 1}
                </span>
                <span className="min-w-0 flex-1 text-[15px]">{STEP_TITLE[s]}</span>
                {done(s) ? <span className="sr-only">(answered)</span> : null}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </nav>
  );
}

/**
 * Back and Next, docked at the bottom of the screen (sticky, so it rides above the on-screen
 * keyboard when the WebView shrinks for it). The answer has no Next — its own buttons go on.
 */
export function StepDock({ steps, current, onGo }: { steps: StepId[]; current: StepId; onGo: (id: StepId) => void }) {
  const { back, next } = neighbours(steps, current);
  if (!back && !next) return null;
  return (
    <div
      className="sticky bottom-0 z-20 no-print mt-5 -mx-4 px-4 sm:-mx-6 sm:px-6 pt-3 bg-canvas/95 backdrop-blur border-t border-line"
      style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-center gap-2">
        {back ? (
          <button type="button" className="btn !rounded-full !min-h-[48px] !px-5 shrink-0" onClick={() => onGo(back)}>
            <span aria-hidden>‹</span> Back
          </button>
        ) : null}
        {next ? (
          <button type="button" className="btn btn-primary !rounded-full !min-h-[48px] !px-5 ml-auto min-w-0 flex-1 sm:flex-none" onClick={() => onGo(next)}>
            <span className="truncate">Next: {STEP_TITLE[next]}</span> <span aria-hidden>›</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
