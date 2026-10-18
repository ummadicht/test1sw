"use client";

import { useState } from "react";
import { Money, ErrorText } from "@/components/ui";
import { StepCard, StepFigure, StepNoFigure } from "./StepCard";
import { REPAIR_SOURCE, repairLines, repairQuotePatch, repairQuoteProblem, repairStep, type RepairSourceId } from "./caseSteps";
import type { CaseOps } from "./ops";

/**
 * The quote typed in from the bench, the job sheet or another repairer: ONE amount and where it
 * comes from — the choice is the reason the server keeps with it (caseSteps.ts repairQuotePatch).
 */
function RepairQuoteForm({ ops, sources, onDone }: { ops: CaseOps; sources: RepairSourceId[]; onDone?: () => void }) {
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<RepairSourceId>(sources[0] ?? "job_sheet");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const outside = sources.length === 1 && sources[0] === "outside";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const patch = repairQuotePatch(amount, source);
    if (!patch) return setErr(repairQuoteProblem(amount));
    setBusy(true);
    const e2 = await ops.save(patch);
    setBusy(false);
    setErr(e2);
    if (!e2) {
      setAmount("");
      onDone?.();
    }
  }

  return (
    <form onSubmit={submit} className="rounded-[12px] border border-line p-3 sm:p-4 space-y-3">
      <label className="block">
        <span className="label">{outside ? "Customer's outside quote (₹)" : "Service centre's quote (₹)"}</span>
        <div className="flex gap-2">
          <input
            className="input num flex-1 min-w-0"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setErr(null);
            }}
            placeholder="e.g. 8500"
          />
          <button className="btn btn-primary shrink-0" disabled={busy || !amount.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </label>
      {sources.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Where the quote comes from">
          {sources.map((s) => (
            <button key={s} type="button" className="chip !min-h-[38px]" aria-pressed={source === s} onClick={() => setSource(s)}>
              {REPAIR_SOURCE[s].label}
            </button>
          ))}
        </div>
      ) : null}
      <ErrorText error={err} />
    </form>
  );
}

/**
 * REPAIR QUOTE — what the customer pays to keep the phone, as ONE figure. When the price book
 * can't price it: "Needs the service centre's quote", one plain sentence, and one amount field.
 * The parts, labour and GST are a plain list behind "Show details" (caseSteps.ts repairLines);
 * the book's sources stay in the book.
 */
export function StepRepair({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const s = repairStep(view);
  const lines = repairLines(view.repair);

  const details =
    lines.length || view.manualRepair ? (
      <>
        {lines.length ? (
          <ul className="space-y-1 text-[14.5px]">
            {lines.map((l) => (
              <li key={l} className="num">
                {l}
              </li>
            ))}
          </ul>
        ) : null}
        {view.manualRepair ? <p className="text-[13.5px] text-muted">Entered by {view.manualRepair.by}.</p> : null}
      </>
    ) : null;

  return (
    <StepCard
      id="step-repair"
      title="Repair quote"
      figure={
        s.amount !== null ? (
          <StepFigure tone="fix">
            <Money value={s.amount} />
          </StepFigure>
        ) : (
          <StepNoFigure>{s.headline}</StepNoFigure>
        )
      }
      line={s.line}
      details={details}
    >
      {editable && view.manualRepair ? (
        <button type="button" className="btn btn-sm" onClick={async () => setErr(await save({ manualRepair: null }, { manualRepair: null }))}>
          {view.repairNotServiced ? "Remove quote" : "Use price book"}
        </button>
      ) : null}
      {editable && s.form === "needed" ? <RepairQuoteForm ops={ops} sources={s.sources} /> : null}
      {editable && s.form === "optional" ? (
        override ? (
          <RepairQuoteForm ops={ops} sources={s.sources} onDone={() => setOverride(false)} />
        ) : (
          <button type="button" className="btn btn-sm btn-ghost !px-0 text-fix" onClick={() => setOverride(true)}>
            Different quote?
          </button>
        )
      ) : null}
      {err ? <ErrorText error={err} /> : null}
    </StepCard>
  );
}
