"use client";

import { useState } from "react";
import { ErrorText, Field } from "@/components/ui";
import type { CaseOps } from "./ops";
import { IDENTITY_REASON_MIN, partnerQuoteProblem, identityReasonOk, wholeRupees } from "./answerAsks";

/**
 * The two asks the answer card answers in place, because no folded step can
 * (answerAsks.ts askControl says when):
 *
 *   PartnerQuoteEntry  a quote read off the partner's app, for a lapsed one or a phone that
 *                      measured a size not on file — the store app's PartnerQuoteSheet, word
 *                      for word. It replaces whatever partner-app quote the case held.
 *   IdentityOverride   the store manager's "This is the right phone" against the camera's
 *                      identity mismatch, with the reason the server keeps by their name.
 *
 * The server checks both again and its sentence is shown when it refuses.
 */

export function PartnerQuoteEntry({ ops, why, size }: { ops: CaseOps; why: "lapsed" | "unlisted"; size: string | null }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [repaired, setRepaired] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        {why === "lapsed" ? "Enter today's quote" : `Enter partner quote${size ? ` for ${size}` : ""}`}
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = partnerQuoteProblem(amount, reference, repaired);
    if (problem) return setErr(problem);
    setSaving(true);
    const e2 = await ops.save({ partnerQuote: { amount: wholeRupees(amount)!, reference: reference.trim().toUpperCase(), repairedAmount: repaired.trim() ? wholeRupees(repaired) : null } });
    setSaving(false);
    setErr(e2);
    if (!e2) setOpen(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[14px] text-ink-2 leading-snug">Price it in the partner app, then enter its price and code.</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="As-is price (₹)">
          <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 18800" autoFocus />
        </Field>
        <Field label="Reference code">
          <input
            className="input num uppercase"
            value={reference}
            onChange={(e) => setReference(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40))}
            placeholder="e.g. PQ-82731"
            maxLength={40}
            autoComplete="off"
          />
        </Field>
        <Field label="Repaired value (optional)">
          <input className="input num" inputMode="numeric" value={repaired} onChange={(e) => setRepaired(e.target.value)} placeholder="if the app showed it" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save quote"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={saving}
          onClick={() => {
            setErr(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

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
