"use client";

import { useState } from "react";
import { Money, Pct, Banner, SourceBadge, ErrorText } from "@/components/ui";
import type { PartnerQuote } from "@/lib/server/buyback";
import { StepCard } from "./StepCard";
import { fmtWhen } from "./shared";
import type { CaseOps } from "./ops";

/** SourceBadge, with a short label for a quote typed in from the partner's own app. */
export function QuoteSource({ quote }: { quote: Pick<PartnerQuote, "source"> | null | undefined }) {
  if (!quote) return null;
  if (quote.source.kind === "partner_manual") return <SourceBadge kind="partner_manual" label="From the partner app" />;
  return <SourceBadge kind={quote.source.kind} label={quote.source.label} />;
}

function Trace({ quote, partner }: { quote: PartnerQuote; partner: string }) {
  return (
    <details className="mt-3 rounded-[11px] border border-line">
      <summary className="cursor-pointer px-4 py-2.5 text-[14px] font-semibold">How {partner} got to {quote.amount === null ? "—" : <Money value={quote.amount} />}</summary>
      <div className="px-4 pb-3">
        <table className="w-full text-[14px]">
          <tbody>
            {quote.lines.map((l, i) => (
              <tr key={`${l.label}-${i}`} className="border-t border-line first:border-t-0">
                <td className="py-1.5 pr-3 text-ink-2">
                  {l.label}
                  {l.bp ? (
                    <span className="text-muted">
                      {" "}
                      (<Pct bp={l.bp} />)
                    </span>
                  ) : null}
                </td>
                <td className={`py-1.5 text-right whitespace-nowrap ${l.amount < 0 ? "text-bad" : ""}`}>
                  <Money value={l.amount} sign={i > 0} />
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-line">
              <td className="py-1.5 font-bold">Trade-in value</td>
              <td className="py-1.5 text-right font-bold">
                <Money value={quote.amount} />
              </td>
            </tr>
          </tbody>
        </table>
        <div className="hint">
          {quote.source.label}
          {quote.source.effectiveFrom ? ` · effective ${fmtWhen(quote.source.effectiveFrom, "date")}` : ""}
          {quote.quotedAt ? ` · quoted ${fmtWhen(quote.quotedAt)}` : ""}
        </div>
      </div>
    </details>
  );
}

/** The quote read off the partner's own app, with its reference code — binding as entered. */
function PartnerQuoteForm({ ops, partner }: { ops: CaseOps; partner: string }) {
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [days, setDays] = useState("3");
  const [repaired, setRepaired] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const num = (s: string) => Number(s.replace(/[,\s₹]/g, ""));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = num(amount);
    if (!Number.isInteger(a) || a <= 0) return setErr(`Enter ${partner}'s quote as a whole rupee amount.`);
    if (!/^[A-Za-z0-9-]{4,40}$/.test(ref.trim())) return setErr(`Enter the reference code ${partner}'s app shows for this quote (letters, digits, dashes).`);
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 30) return setErr("Quote validity must be 1–30 days.");
    const r = repaired.trim() ? num(repaired) : null;
    if (r !== null && (!Number.isInteger(r) || r < a)) return setErr("The repaired value must be a whole rupee amount, at least the as-is quote.");
    setBusy(true);
    const e2 = await ops.save({ partnerQuote: { amount: a, reference: ref.trim(), validDays: d, repairedAmount: r } });
    setBusy(false);
    setErr(e2);
  }

  return (
    <form onSubmit={submit} className="px-4 pb-4 space-y-3">
      <p className="hint !mt-0">
        Use this when {partner}&apos;s own app gave the customer a quote for this phone. It replaces the rate-card figure for this case only, and is
        dropped automatically if you change the phone&apos;s description.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Quote (₹)</span>
          <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 12500" />
        </label>
        <label className="block">
          <span className="label">Reference code</span>
          <input className="input num uppercase" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="as shown in the app" maxLength={40} autoComplete="off" />
        </label>
        <label className="block">
          <span className="label">Valid for (days)</span>
          <input className="input num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Value in repaired condition (optional)</span>
          <input className="input num" inputMode="numeric" value={repaired} onChange={(e) => setRepaired(e.target.value)} placeholder="if the app showed it" />
        </label>
      </div>
      <button className="btn btn-sm btn-primary" disabled={busy}>
        {busy ? "Saving…" : `Use ${partner}'s quote`}
      </button>
      <ErrorText error={err} />
    </form>
  );
}

/** ⑤ What the buyback partner pays for the phone as it is — and what it would be worth repaired. */
export function StepTradeIn({ ops }: { ops: CaseOps }) {
  const { view, editable, act, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [requoting, setRequoting] = useState(false);
  const q = view.quote;
  const rq = view.repairedQuote;
  const partner = q?.partner ?? view.partner?.partnerName ?? "The partner";
  const priced = q?.status === "priced" && q.amount !== null;
  const done = priced && !view.quoteExpired;

  const needs: string[] = [];
  if (!view.device?.variant) needs.push("Choose the model and storage (step 1).");
  if (!view.condition) needs.push("Answer the condition questions (step 3).");
  else if (view.conditionProblems.length) needs.push("Fix the condition — it is recorded better than the faults allow (step 3).");

  async function requote() {
    setRequoting(true);
    setErr(await act("reprice", { requote: true }));
    setRequoting(false);
  }

  return (
    <StepCard
      n={5}
      id="step-tradein"
      title={`Trade-in value from ${partner}`}
      done={done}
      aside={q ? <QuoteSource quote={q} /> : view.partner ? <SourceBadge kind={view.partner.kind} label={view.partner.label} /> : null}
    >
      {view.partner ? <p className="hint !mt-0 mb-3">{view.partner.why}</p> : null}
      {q?.source.kind === "sample" ? (
        <div className="mb-3">
          <Banner tone="sample">SAMPLE price — illustrative only, not {partner}&apos;s. Don&apos;t quote it to the customer as a real offer.</Banner>
        </div>
      ) : null}

      {!q ? (
        <div className="text-[14px] text-ink-2">
          <div className="font-semibold">No trade-in value yet</div>
          <ul className="list-disc pl-5 mt-1 text-muted">
            {needs.length ? needs.map((n) => <li key={n}>{n}</li>) : <li>Waiting for the partner&apos;s answer.</li>}
          </ul>
        </div>
      ) : !priced ? (
        <Banner tone="warn">
          <div className="font-semibold">{q.status === "error" ? `${partner} did not answer` : `${partner} has no price for this phone`}</div>
          {q.reason ? <div className="mt-1">{q.reason}</div> : null}
        </Banner>
      ) : (
        <div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[13px] text-muted">{partner} pays for it as it is</div>
              <div className="text-[34px] font-[780] tracking-tight leading-none mt-1">
                <Money value={q.amount} />
              </div>
            </div>
            <div className="text-right text-[13px]">
              <div className={view.quoteExpired ? "text-bad font-semibold" : "text-ink-2"}>
                {view.quoteExpired ? "Expired " : "Valid until "}
                {fmtWhen(q.validUntil)}
              </div>
              {q.partnerRef ? <div className="text-muted num">Ref {q.partnerRef}</div> : null}
            </div>
          </div>
          {view.quoteExpired ? (
            <div className="mt-3">
              <Banner tone="warn">
                This quote has expired. Re-quote before taking the phone — the price may have changed.
                {editable ? (
                  <div className="mt-2">
                    <button type="button" className="btn btn-sm" onClick={requote} disabled={requoting}>
                      {requoting ? "Re-quoting…" : "Re-quote"}
                    </button>
                  </div>
                ) : null}
              </Banner>
            </div>
          ) : null}
          <Trace quote={q} partner={partner} />
        </div>
      )}

      {/* Repaired value */}
      {view.faults.length > 0 && view.condition ? (
        <div className="mt-4 rounded-[12px] bg-surface-2 border border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[13px] text-muted">Worth once repaired (resale value, for comparison)</div>
              <div className="text-[20px] font-[720]">{rq?.status === "priced" ? <Money value={rq.amount} /> : <span className="text-muted">—</span>}</div>
            </div>
            {rq?.status === "priced" ? <QuoteSource quote={rq} /> : null}
          </div>
          <div className="hint">
            {rq?.status === "priced"
              ? `${rq.source.label}. A what-if price — never an offer.`
              : rq?.reason
                ? rq.reason
                : q?.source.kind === "partner_manual"
                  ? `Not available: only ${partner}'s real rate card may supply a repaired value next to a quote from its app. Enter it from the app if it showed one.`
                  : "Not available for this phone."}
          </div>
        </div>
      ) : null}

      {/* Partner-app quote */}
      {view.partnerManual ? (
        <div className="mt-4 rounded-[12px] border border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[14px]">
              <span className="font-semibold">Entered from the {partner} app:</span> <Money value={view.partnerManual.amount} /> · ref{" "}
              <span className="num">{view.partnerManual.reference}</span>
              {view.partnerManual.repairedAmount !== null ? (
                <>
                  {" "}
                  · repaired <Money value={view.partnerManual.repairedAmount} />
                </>
              ) : null}
            </div>
            {editable ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={async () => setErr(await save({ partnerQuote: null }, { partnerManual: null }))}>
                Remove
              </button>
            ) : null}
          </div>
          <div className="hint">
            By {view.partnerManual.by}, {fmtWhen(view.partnerManual.at)} · valid until {fmtWhen(view.partnerManual.validUntil)}
          </div>
        </div>
      ) : editable && view.device?.variant && view.condition && view.conditionProblems.length === 0 ? (
        <details className="mt-4 rounded-[12px] border border-line" open={q?.status === "unpriced" || q?.status === "error"}>
          <summary className="cursor-pointer px-4 py-3 text-[14px] font-semibold">Enter the quote from the {partner} app</summary>
          <PartnerQuoteForm ops={ops} partner={partner} />
        </details>
      ) : null}

      {editable && q && !view.quoteExpired && !view.partnerManual ? (
        <div className="mt-3">
          <button type="button" className="btn btn-sm btn-ghost !px-0" onClick={requote} disabled={requoting}>
            {requoting ? "Re-quoting…" : `↻ Re-quote from ${partner}`}
          </button>
        </div>
      ) : null}
      <ErrorText error={err} />
    </StepCard>
  );
}
