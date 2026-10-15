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
import { StepCard, ChipGroup } from "./StepCard";
import { alignToFloor } from "./shared";
import type { CaseOps } from "./ops";

const ISSUES = Object.keys(ISSUE_LABEL) as IssueId[];
const AGES = Object.keys(AGE_LABEL) as AgeBand[];

/** ③ The trade-in condition — what the buyback partner prices. Prefilled from the faults; never better than them. */
export function StepCondition({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const c = view.condition;

  async function put(next: ConditionAnswers) {
    setErr(await save({ condition: next }, { condition: next, conditionProblems: conditionFloor(next, view.faults) }));
  }

  if (!c) {
    return (
      <StepCard n={3} id="step-condition" title="Condition for the trade-in">
        <p className="text-[14px] text-ink-2">
          Record what&apos;s wrong in step 2 first — these answers are filled in from the faults, then you check the phone and correct anything
          that is worse.
        </p>
        {editable ? (
          <button type="button" className="btn btn-sm mt-3" onClick={async () => setErr(await save({ conditionFromFaults: true }))}>
            Fill in from the faults now
          </button>
        ) : null}
        <ErrorText error={err} />
      </StepCard>
    );
  }

  const floor = conditionFromFaults(view.faults, c);
  const floorScreen = SCREEN_ORDER.indexOf(floor.screen);
  const floorBody = BODY_ORDER.indexOf(floor.body);
  const done = view.conditionProblems.length === 0;

  return (
    <StepCard n={3} id="step-condition" title="Condition for the trade-in" done={done}>
      <p className="text-[14px] text-ink-2 mb-4">
        Filled in from the faults. Check the phone in hand and make anything <strong>worse</strong> that you can see — a scuff, a missing
        charger. It can&apos;t be recorded better than the faults allow.
      </p>

      {view.conditionProblems.length ? (
        <div className="mb-4">
          <Banner tone="bad">
            <div className="font-semibold">The condition is recorded better than the faults allow — the trade-in can&apos;t be priced until it matches.</div>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              {view.conditionProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {editable ? (
              <button type="button" className="btn btn-sm mt-2" onClick={() => put(alignToFloor(c, view.faults))}>
                Bring it in line with the faults
              </button>
            ) : null}
          </Banner>
        </div>
      ) : null}

      <div className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <ChipGroup label="Does it switch on?">
            <button type="button" className="chip" aria-pressed={c.powersOn} disabled={!editable || floor.powersOn === false} onClick={() => put({ ...c, powersOn: true })} title={floor.powersOn === false ? "A recorded fault says it does not switch on" : undefined}>
              Yes
            </button>
            <button type="button" className="chip" aria-pressed={!c.powersOn} disabled={!editable} onClick={() => put({ ...c, powersOn: false })}>
              No
            </button>
          </ChipGroup>
          <ChipGroup label="Can it make calls?">
            <button type="button" className="chip" aria-pressed={c.calls} disabled={!editable || floor.calls === false} onClick={() => put({ ...c, calls: true })} title={floor.calls === false ? "A recorded fault says calls fail" : undefined}>
              Yes
            </button>
            <button type="button" className="chip" aria-pressed={!c.calls} disabled={!editable} onClick={() => put({ ...c, calls: false })}>
              No
            </button>
          </ChipGroup>
        </div>
        {!c.powersOn ? (
          <Banner>A phone that won&apos;t switch on is priced as non-working — the screen and body answers below don&apos;t change its trade-in value.</Banner>
        ) : null}

        <ChipGroup
          label="Screen"
          hint={floorScreen > 0 ? `A recorded fault means the screen is at least “${SCREEN_LABEL[floor.screen]}” — better options are locked.` : undefined}
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
                title={locked ? `Not possible with the recorded faults (at least “${SCREEN_LABEL[floor.screen]}”)` : undefined}
                onClick={() => put({ ...c, screen: s })}
              >
                {SCREEN_LABEL[s]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup
          label="Body and back"
          hint={floorBody > 0 ? `A recorded fault means the body is at least “${BODY_LABEL[floor.body]}” — better options are locked.` : undefined}
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
                title={locked ? `Not possible with the recorded faults (at least “${BODY_LABEL[floor.body]}”)` : undefined}
                onClick={() => put({ ...c, body: b })}
              >
                {BODY_LABEL[b]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup label="Anything else not working?" hint={floor.issues.length ? "Issues that come from a recorded fault stay ticked." : "Tick only what you have checked."}>
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
                title={fromFault ? "Recorded as a fault in step 2" : undefined}
                onClick={() => put({ ...c, issues: (on ? c.issues.filter((x) => x !== i) : [...c.issues, i]).sort() as IssueId[] })}
              >
                {ISSUE_LABEL[i]}
              </button>
            );
          })}
        </ChipGroup>

        <ChipGroup label="What comes with it" hint="Original items only. Missing ones lower the partner's price.">
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

        <ChipGroup label="How old is it?" hint="From the purchase bill. Without a bill, use the launch year above.">
          {AGES.map((a) => (
            <button key={a} type="button" className="chip" aria-pressed={c.age === a} disabled={!editable} onClick={() => put({ ...c, age: a })}>
              {AGE_LABEL[a]}
            </button>
          ))}
        </ChipGroup>
      </div>
      <ErrorText error={err} />
    </StepCard>
  );
}
