"use client";

import { useState, type ReactNode } from "react";
import { ErrorText } from "@/components/ui";
import { FAULT_BY_ID, conditionFromFaults, conditionFloor, type FaultId } from "@/lib/domain/condition";
import type { CasePatch, CaseView } from "@/lib/server/cases";
import { StepCard } from "./StepCard";
import { ConditionEditor, ConditionProblems } from "./StepCondition";
import { FAULT_GROUPS, reconcileCondition } from "./shared";
import { faultsLine } from "./caseSteps";
import type { CaseOps } from "./ops";

/** The base the server uses when it fills a brand-new condition from the faults. */
const NEW_CONDITION_BASE = { accessories: { charger: true, box: false, bill: false }, age: "gt11m" as const };

/**
 * WHAT'S WRONG — the faults, in the service centre's language, and the trade-in condition that
 * follows from them, as ONE step. The faults are the question; the condition they fill in is its
 * one line, and is corrected (only ever made worse) behind "Show details", with Phonecheck.
 */
export function StepFaults({ ops, phonecheck }: { ops: CaseOps; phonecheck?: ReactNode }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const faults = view.faults;
  const nothingWrong = faults.length === 0 && view.condition !== null;

  async function setFaults(next: FaultId[]) {
    const patch: CasePatch = { faults: next };
    const opt: Partial<CaseView> = { faults: next };
    if (view.condition === null) {
      // First answer: the condition is filled in from the faults (corrected under "Show details").
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

  const details = (
    <>
      <p className="hint !mt-0">&ldquo;Inspect&rdquo; faults need the service centre&apos;s quote.</p>
      <ConditionEditor ops={ops} />
      {phonecheck}
    </>
  );

  return (
    <StepCard id="step-faults" title="What's wrong with it?" line={faultsLine(view)} details={details}>
      <div>
        <button
          type="button"
          className="chip"
          aria-pressed={nothingWrong}
          disabled={!editable}
          onClick={() => setFaults([])}
        >
          Nothing wrong
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
                    title={def.part ? undefined : "Needs a bench quote"}
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
      <ConditionProblems ops={ops} />
      <ErrorText error={err} />
    </StepCard>
  );
}
