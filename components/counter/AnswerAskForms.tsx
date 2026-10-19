"use client";

import { useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import type { CaseOps } from "./ops";
import { IDENTITY_REASON_MIN, identityReasonOk } from "./answerAsks";

/**
 * The one ask the answer card answers in place, because no folded step can (answerAsks.ts
 * askControl says when): the store manager's "This is the right phone" against the camera's
 * identity mismatch, with the reason the server keeps by their name. The server checks it again
 * and its sentence is shown when it refuses. No price is ever typed in here.
 */

export function IdentityOverride({ ops }: { ops: CaseOps }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ok = identityReasonOk(reason);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setSaving(true);
    // The server re-prices on success, and the blocked ask goes with the block.
    setErr(await ops.save({ cameraOverride: { identity: true, reason: reason.trim() } }));
    setSaving(false);
  }

  return (
    <form onSubmit={accept} className="space-y-2">
      <Field label="How you checked" hint={`${IDENTITY_REASON_MIN}+ characters, kept with your name.`}>
        <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
      <button className="btn btn-sm btn-primary" disabled={!ok || saving}>
        {saving ? "Saving…" : "Confirm phone"}
      </button>
      <ErrorText error={err} />
    </form>
  );
}
