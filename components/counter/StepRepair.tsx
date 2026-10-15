"use client";

import { useState } from "react";
import { Money, Banner, ErrorText } from "@/components/ui";
import { FAULT_BY_ID } from "@/lib/domain/condition";
import { StepCard } from "./StepCard";
import { COVER_LABEL } from "./shared";
import type { CaseOps } from "./ops";

/** The service centre's own figure — from its job sheet, or the customer's outside quote. */
function ManualRepairForm({ ops, title, hint, onDone }: { ops: CaseOps; title: string; hint: string; onDone?: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amount.replace(/[,\s₹]/g, ""));
    if (!amount.trim() || !Number.isInteger(n) || n < 0) return setErr("Enter the quote as a whole rupee amount.");
    if (reason.trim().length < 8) return setErr("Say where the quote comes from — e.g. the job-sheet number.");
    setBusy(true);
    const e2 = await ops.save({ manualRepair: { amount: n, reason: reason.trim() } });
    setBusy(false);
    setErr(e2);
    if (!e2) {
      setAmount("");
      setReason("");
      onDone?.();
    }
  }

  return (
    <form onSubmit={submit} className="rounded-[12px] border border-line p-4 mt-3 space-y-3">
      <div>
        <div className="font-semibold text-[15px]">{title}</div>
        <div className="hint !mt-0.5">{hint}</div>
      </div>
      <div className="grid sm:grid-cols-[180px_minmax(0,1fr)] gap-3">
        <label className="block">
          <span className="label">Amount the customer pays (₹)</span>
          <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 8500" />
        </label>
        <label className="block">
          <span className="label">Where this quote comes from</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. job sheet no. JS-24117, bench diagnosis" maxLength={200} />
        </label>
      </div>
      <button className="btn btn-sm btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Use this quote"}
      </button>
      <ErrorText error={err} />
    </form>
  );
}

/** ④ What the repair costs: Samsung list price + labour + GST, adjusted for cover — or the bench's own quote. */
export function StepRepair({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const r = view.repair;
  const nothing = (view.faults.length === 0 && !view.manualRepair) || r?.status === "nothing_to_repair";
  const done = r?.status === "quoted" || (nothing && view.condition !== null);

  let body: React.ReactNode;
  if (!view.device) {
    body = <p className="text-[14px] text-muted">Choose the phone in step 1 first.</p>;
  } else if (view.manualRepair) {
    body = (
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[13px] text-muted">{view.repairNotServiced ? "Customer's outside repair quote" : "Service centre's quote"}</div>
            <div className="kpi text-fix">
              <Money value={view.manualRepair.amount} />
            </div>
          </div>
          <span className="pill pill-warn">Entered by staff</span>
        </div>
        <p className="text-[14px] text-ink-2 mt-2">
          {view.manualRepair.reason} <span className="text-muted">— {view.manualRepair.by}</span>
        </p>
        {editable ? (
          <button
            type="button"
            className="btn btn-sm mt-3"
            onClick={async () => setErr(await save({ manualRepair: null }, { manualRepair: null }))}
          >
            {view.repairNotServiced ? "Remove this quote" : "Use the price book instead"}
          </button>
        ) : null}
      </div>
    );
  } else if (view.repairNotServiced) {
    body = (
      <div>
        <Banner>{view.repairNotServiced}</Banner>
        {editable ? (
          <ManualRepairForm
            ops={ops}
            title="Customer's outside repair quote"
            hint="What another repairer quoted the customer, so the two options can be compared fairly."
          />
        ) : null}
      </div>
    );
  } else if (nothing) {
    body = (
      <div>
        <div className="text-[17px] font-semibold">Nothing to repair</div>
        <p className="text-[14px] text-muted mt-1">
          {view.condition ? "No faults recorded — this is a straight trade-in." : "No faults recorded yet. If something is wrong, tick it in step 2."}
        </p>
      </div>
    );
  } else if (!r) {
    body = <p className="text-[14px] text-muted">The repair is priced once the model and the faults are recorded.</p>;
  } else {
    const partsCharged = r.lines.reduce((s, l) => s + l.charged, 0);
    body = (
      <div>
        {r.status !== "quoted" ? (
          <Banner tone="warn">
            <div className="font-semibold">
              {r.status === "needs_inspection" ? "This repair needs a bench diagnosis before it can be priced." : "The price book has no price for a part this repair needs."}
            </div>
            <div className="mt-1">Until the service centre gives its quote there is no repair figure to compare — the app won&apos;t guess one.</div>
          </Banner>
        ) : null}

        {r.lines.length ? (
          <ul className="mt-3 border-y border-line divide-y divide-[color:var(--line)]">
            {r.lines.map((l) => (
              <li key={l.part} className="py-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <div className="font-semibold text-[15px]">{l.label}</div>
                  <div className="text-[13px] text-ink-2">Fixes: {l.faults.map((f) => FAULT_BY_ID[f]?.label ?? f).join(", ")}</div>
                  {l.source ? (
                    <div className="text-[12px] text-muted">
                      {l.source.label}
                      {l.source.url ? (
                        <>
                          {" "}
                          <a href={l.source.url} target="_blank" rel="noreferrer" className="whitespace-nowrap">
                            source ↗
                          </a>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[12px] text-bad">No price in the book for this part on this model</div>
                  )}
                </div>
                <div className="text-right">
                  {l.covered ? (
                    <span className="pill pill-up">Covered</span>
                  ) : (
                    <Money value={l.listPrice === null ? null : l.charged} className="text-[15px] font-semibold" />
                  )}
                  <div className="text-[12px] text-muted whitespace-nowrap">
                    list price <Money value={l.listPrice} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {r.status === "quoted" ? (
          <dl className="mt-3 space-y-1.5 text-[14px] max-w-[420px] ml-auto">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-2">Parts</dt>
              <dd>
                <Money value={partsCharged} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-2">Labour / service charge</dt>
              <dd>
                <Money value={r.labour} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-2">GST on parts and labour</dt>
              <dd>
                <Money value={r.gst} />
              </dd>
            </div>
            {r.carePlusFee ? (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">{COVER_LABEL.care_plus} claim fee</dt>
                <dd>
                  <Money value={r.carePlusFee} />
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4 items-baseline border-t border-line pt-2 mt-2">
              <dt className="font-bold">Customer pays</dt>
              <dd className="text-[24px] font-[760] text-fix">
                <Money value={r.customerPays} />
              </dd>
            </div>
            {r.listTotal !== null && r.listTotal !== r.customerPays ? (
              <div className="flex justify-between gap-4 text-muted text-[13px]">
                <dt>Without cover it would be</dt>
                <dd>
                  <Money value={r.listTotal} />
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {r.notes.length ? (
          <ul className="mt-3 space-y-1 text-[13px] text-ink-2 list-disc pl-5">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}

        {editable && r.status !== "quoted" ? (
          <ManualRepairForm ops={ops} title="Enter the service centre's quote" hint="The figure from the bench or the job system. It replaces the price book for this case." />
        ) : null}
        {editable && r.status === "quoted" ? (
          override ? (
            <ManualRepairForm ops={ops} title="Use the bench's quote instead" hint="Only if the bench quoted a different figure. It replaces the price book for this case." onDone={() => setOverride(false)} />
          ) : (
            <button type="button" className="btn btn-sm btn-ghost mt-2 !px-0" onClick={() => setOverride(true)}>
              The bench quoted something else?
            </button>
          )
        ) : null}
      </div>
    );
  }

  return (
    <StepCard
      n={4}
      id="step-repair"
      title="Repair quote"
      done={done}
      aside={view.repair?.basis === "book" && view.repair.status === "quoted" ? <span className="pill">List price + labour + GST</span> : null}
    >
      {body}
      <ErrorText error={err} />
    </StepCard>
  );
}
