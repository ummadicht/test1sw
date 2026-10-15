"use client";

import { useState } from "react";
import { ErrorText } from "@/components/ui";
import { FAULT_BY_ID, conditionFromFaults, conditionFloor, type FaultId } from "@/lib/domain/condition";
import type { CasePatch, CaseView } from "@/lib/server/cases";
import { StepCard } from "./StepCard";
import { FAULT_GROUPS, reconcileCondition } from "./shared";
import type { CaseOps } from "./ops";

/** The base the server uses when it fills a brand-new condition from the faults. */
const NEW_CONDITION_BASE = { accessories: { charger: true, box: false, bill: false }, age: "gt11m" as const };

/** ② What's wrong — in the service centre's language (faults). The trade-in condition follows from it. */
export function StepFaults({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const faults = view.faults;
  const nothingWrong = faults.length === 0 && view.condition !== null;

  async function setFaults(next: FaultId[]) {
    const patch: CasePatch = { faults: next };
    const opt: Partial<CaseView> = { faults: next };
    if (view.condition === null) {
      // First answer: the condition is prefilled from the faults (the advisor confirms it in step 3).
      patch.conditionFromFaults = true;
      opt.condition = conditionFromFaults(next, NEW_CONDITION_BASE);
      opt.conditionProblems = [];
    } else {
      const cond = reconcileCondition(view.condition, faults, next);
      patch.condition = cond;
      opt.condition = cond;
      opt.conditionProblems = conditionFloor(cond, next);
    }
    setErr(await save(patch, opt));
  }

  const toggle = (f: FaultId) => setFaults(faults.includes(f) ? faults.filter((x) => x !== f) : [...faults, f]);

  return (
    <StepCard n={2} id="step-faults" title="What's wrong with it" done={faults.length > 0 || nothingWrong}>
      <p className="text-[14px] text-ink-2 mb-4">Tick everything the customer reports and you can see. One part often fixes several faults — the quote counts it once.</p>
      <div className="mb-4">
        <button
          type="button"
          className="chip"
          aria-pressed={nothingWrong}
          disabled={!editable}
          onClick={() => setFaults([])}
          title="No faults — the customer only wants to trade the phone in"
        >
          Nothing wrong — just trading in
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {FAULT_GROUPS.map((g) => (
          <div key={g.title}>
            <div className="label">{g.title}</div>
            <div className="flex flex-wrap gap-2">
              {g.faults.map((f) => {
                const def = FAULT_BY_ID[f];
                return (
                  <button
                    key={f}
                    type="button"
                    className="chip"
                    aria-pressed={faults.includes(f)}
                    disabled={!editable}
                    onClick={() => toggle(f)}
                    title={def.part ? undefined : "No fixed price — needs a bench diagnosis"}
                  >
                    {def.label}
                    {def.part ? null : <span className="text-[11px] opacity-70">· inspect</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {faults.some((f) => !FAULT_BY_ID[f].part) ? (
        <p className="hint mt-3">Faults marked &ldquo;inspect&rdquo; have no list price — the repair needs the bench&apos;s quote (step 4).</p>
      ) : null}
      <ErrorText error={err} />
    </StepCard>
  );
}
