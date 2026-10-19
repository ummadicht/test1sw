"use client";

import { useState } from "react";
import { ErrorText } from "@/components/ui";
import { certifyWaiting } from "@/lib/domain/autoApply";
import type { CaseOps } from "./ops";

/** The button, word for word (owner, 2026-10-19: "Skip and get on advisor app fast"). */
export const ALL_FINE_BUTTON = "All fine — screen OK, body like new";

/**
 * "Check the phone" on the desk: the store camera couldn't decide the screen or the body, so the
 * advisor looks at the phone. One tap — "All fine — screen OK, body like new" — records the screen
 * OK, the body like new and the liquid indicator "Can't see" (honest: nobody looked at it), by name,
 * exactly as the three taps in SwapUp Store would ({action: "certify", allFine: true}), and opens the
 * answer. Anything else is the faults and the condition on "What's wrong".
 */
export function CheckByEye({ ops, onDone, onOther }: { ops: CaseOps; onDone: () => void; onOther: () => void }) {
  const { view, act, editable } = ops;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!editable || !certifyWaiting(view.certify)) return null;

  async function allFine() {
    setBusy(true);
    const e = await act("certify", { allFine: true, testSessionId: view.certify?.testSessionId ?? undefined });
    setBusy(false);
    setErr(e);
    if (!e) onDone();
  }

  return (
    <section className="card card-pad mb-4 space-y-2" aria-label="Check the phone">
      <button type="button" className="btn btn-primary w-full !whitespace-normal leading-tight" disabled={busy} onClick={allFine}>
        {busy ? "Saving…" : ALL_FINE_BUTTON}
      </button>
      <div className="text-[15px] font-[720] leading-tight">Check the phone</div>
      <p className="text-[14px] text-ink-2 leading-snug">The store camera couldn&apos;t decide the screen or the body — look at the phone.</p>
      <button type="button" className="text-[13.5px] font-semibold text-fix hover:underline" onClick={onOther}>
        Something&apos;s wrong
      </button>
      <ErrorText error={err} />
    </section>
  );
}
