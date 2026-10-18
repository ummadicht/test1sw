"use client";

import { useState } from "react";
import { Banner, ErrorText } from "@/components/ui";
import {
  SCREEN_ORDER,
  BODY_ORDER,
  SCREEN_LABEL,
  BODY_LABEL,
  ISSUE_LABEL,
  AGE_LABEL,
  conditionFromFaults,
  conditionFloor,
  type ConditionAnswers,
  type IssueId,
  type AgeBand,
} from "@/lib/domain/condition";
import { ChipGroup } from "./StepCard";
import { alignToFloor } from "./shared";
import type { CaseOps } from "./ops";

const ISSUES = Object.keys(ISSUE_LABEL) as IssueId[];
const AGES = Object.keys(AGE_LABEL) as AgeBand[];

/**
 * The condition is recorded better than the faults allow: the trade-in can't be priced until it
 * matches. Shown on the step itself (not behind "Show details"), with the one-tap fix.
 */
export function ConditionProblems({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const c = view.condition;
  if (!c || !view.conditionProblems.length) return null;
  async function align() {
    const next = alignToFloor(c!, view.faults);
    setErr(await save({ condition: next }, { condition: next, conditionProblems: conditionFloor(next, view.faults) }));
  }
  return (
    <Banner tone="bad">
      <div className="font-semibold">Condition is better than the faults allow.</div>
      <ul className="list-disc pl-4 mt-1 space-y-0.5">
        {view.conditionProblems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {editable ? (
        <button type="button" className="btn btn-sm mt-2" onClick={align}>
          Match the faults
        </button>
      ) : null}
      <ErrorText error={err} />
    </Banner>
  );
}

/**
 * The trade-in condition — what the buyback partner prices. Filled in from the faults, never
 * better than them; on the "What's wrong" step, behind "Show details" (StepFaults).
 */
export function ConditionEditor({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const c = view.condition;

  async function put(next: ConditionAnswers) {
    setErr(await save({ condition: next }, { condition: next, conditionProblems: conditionFloor(next, view.faults) }));
  }

  if (!c) {
    return (
      <div>
        <div className="section-title">Trade-in condition</div>
        <p className="text-[14px] text-ink-2 mt-1">Tick the faults first.</p>
        {editable ? (
          <button type="button" className="btn btn-sm mt-3" onClick={async () => setErr(await save({ conditionFromFaults: true }))}>
            Fill from faults
          </button>
        ) : null}
        <ErrorText error={err} />
      </div>
    );
  }

  const floor = conditionFromFaults(view.faults, c);
  const floorScreen = SCREEN_ORDER.indexOf(floor.screen);
  const floorBody = BODY_ORDER.indexOf(floor.body);

  return (
    <div>
      <div className="section-title">Trade-in condition</div>
      <p className="text-[14px] text-ink-2 mt-1 mb-4">
        Filled from the faults. You can only make it <strong>worse</strong>.
      </p>

      <div className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <ChipGroup label="Switches on?">
            <button type="button" className="chip" aria-pressed={c.powersOn} disabled={!editable || floor.powersOn === false} onClick={() => put({ ...c, powersOn: true })} title={floor.powersOn === false ? "A fault says it doesn't" : undefined}>
              Yes
            </button>
            <button type="button" className="chip" aria-pressed={!c.powersOn} disabled={!editable} onClick={() => put({ ...c, powersOn: false })}>
              No
            </button>
          </ChipGroup>
          <ChipGroup label="Makes calls?">
            <button type="button" className="chip" aria-pressed={c.calls} disabled={!editable || floor.calls === false} onClick={() => put({ ...c, calls: true })} title={floor.calls === false ? "A fault says calls fail" : undefined}>
              Yes
            </button>
            <button type="button" className="chip" aria-pressed={!c.calls} disabled={!editable} onClick={() => put({ ...c, calls: false })}>
              No
            </button>
          </ChipGroup>
        </div>
        {!c.powersOn ? (
          <Banner>Priced as non-working.</Banner>
        ) : null}

        <ChipGroup
          label="Screen"
          hint={floorScreen > 0 ? `At least “${SCREEN_LABEL[floor.screen]}” — from the faults.` : undefined}
        >
          {SCREEN_ORDER.map((s, i) => {
            const locked = i < floorScreen;
            return (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={c.screen === s}
                disabled={!editable || locked}
                title={locked ? `Faults say at least “${SCREEN_LABEL[floor.screen]}”` : undefined}
                onClick={() => put({ ...c, screen: s })}
              >
                {SCREEN_LABEL[s]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup
          label="Body and back"
          hint={floorBody > 0 ? `At least “${BODY_LABEL[floor.body]}” — from the faults.` : undefined}
        >
          {BODY_ORDER.map((b, i) => {
            const locked = i < floorBody;
            return (
              <button
                key={b}
                type="button"
                className="chip"
                aria-pressed={c.body === b}
                disabled={!editable || locked}
                title={locked ? `Faults say at least “${BODY_LABEL[floor.body]}”` : undefined}
                onClick={() => put({ ...c, body: b })}
              >
                {BODY_LABEL[b]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup label="Other issues" hint={floor.issues.length ? "Fault issues stay ticked." : "Only what you checked."}>
          {ISSUES.map((i) => {
            const fromFault = floor.issues.includes(i);
            const on = c.issues.includes(i);
            return (
              <button
                key={i}
                type="button"
                className="chip"
                aria-pressed={on}
                disabled={!editable || (fromFault && on)}
                title={fromFault ? "From a fault" : undefined}
                onClick={() => put({ ...c, issues: (on ? c.issues.filter((x) => x !== i) : [...c.issues, i]).sort() as IssueId[] })}
              >
                {ISSUE_LABEL[i]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup label="Comes with" hint="Originals only.">
          {(
            [
              ["charger", "Original charger"],
              ["box", "Original box"],
              ["bill", "Purchase bill"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={c.accessories[k]}
              disabled={!editable}
              onClick={() => put({ ...c, accessories: { ...c.accessories, [k]: !c.accessories[k] } })}
            >
              {c.accessories[k] ? "✓ " : ""}
              {label}
            </button>
          ))}
        </ChipGroup>

        <ChipGroup label="Age" hint="From the bill, else the launch year.">
          {AGES.map((a) => (
            <button key={a} type="button" className="chip" aria-pressed={c.age === a} disabled={!editable} onClick={() => put({ ...c, age: a })}>
              {AGE_LABEL[a]}
            </button>
          ))}
        </ChipGroup>
      </div>
      <ErrorText error={err} />
    </div>
  );
}
