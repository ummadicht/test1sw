"use client";

import { useState } from "react";
import { Money, Pct, SourceBadge, ErrorText } from "@/components/ui";
import type { PartnerQuote } from "@/lib/server/buyback";
import { StepCard, StepFigure, StepNoFigure } from "./StepCard";
import { NewPhone, BonusDetails } from "./StepUpgrade";
import { fmtWhen } from "./shared";
import type { CaseOps, CampaignBand } from "./ops";
import { partnerQuoteLapsed, unlistedSize } from "./answerAsks";
import { quoteSourceLabel, retiredSource } from "@/lib/domain/ratecard";

/** SourceBadge, with a short label for a quote typed in from the partner's own app. */
export function QuoteSource({ quote }: { quote: Pick<PartnerQuote, "source"> | null | undefined }) {
  if (!quote) return null;
  if (quote.source.kind === "partner_manual") return <SourceBadge kind="partner_manual" label="From the partner app" />;
  return <SourceBadge kind={quote.source.kind} label={quote.source.label} />;
}

/** How the trade-in got to its figure — line by line, with where the price came from. The total is the table's last line, not repeated in the title. */
function Trace({ quote }: { quote: PartnerQuote }) {
  return (
    <div>
      <div className="section-title">How it adds up</div>
      <table className="w-full text-[14px] mt-1">
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
        {quoteSourceLabel(quote.source)}
        {quote.source.effectiveFrom && !retiredSource(quote.source.kind) ? ` · effective ${fmtWhen(quote.source.effectiveFrom, "date")}` : ""}
        {quote.quotedAt ? ` · quoted ${fmtWhen(quote.quotedAt)}` : ""}
        {quote.partnerRef ? ` · ref ${quote.partnerRef}` : ""}
        {quote.priceiq?.deductions ? ` · defect % from ${quote.priceiq.deductions}` : ""}
      </div>
      {quote.priceiqWhy ? <div className="hint">Not from PriceIQ: {quote.priceiqWhy}</div> : null}
    </div>
  );
}

/**
 * The quote read off the partner's own app, with its reference code — binding as entered.
 * `measured`: the phone measured a size that isn't on the model's list, and the case has no
 * storage — the quote is for that size and settles the storage at it (cases.ts updateCase).
 */
function PartnerQuoteForm({ ops, measured = null }: { ops: CaseOps; measured?: string | null }) {
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
    if (!Number.isInteger(a) || a <= 0) return setErr("Quote: whole rupees only.");
    if (!/^[A-Za-z0-9-]{4,40}$/.test(ref.trim())) return setErr("Enter the app's reference code.");
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 30) return setErr("Quote validity must be 1–30 days.");
    const r = repaired.trim() ? num(repaired) : null;
    if (r !== null && (!Number.isInteger(r) || r < a)) return setErr("Repaired value must be at least the quote.");
    setBusy(true);
    const e2 = await ops.save({ partnerQuote: { amount: a, reference: ref.trim(), validDays: d, repairedAmount: r } });
    setBusy(false);
    setErr(e2);
  }

  return (
    <form onSubmit={submit} className="px-4 pb-4 space-y-3">
      <p className="hint !mt-0">{measured ? `Price it at ${measured} in the app.` : "Replaces the rate card for this case."}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Quote (₹)</span>
          <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 12500" />
        </label>
        <label className="block">
          <span className="label">Reference code</span>
          <input className="input num uppercase" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. PQ-82731" maxLength={40} autoComplete="off" />
        </label>
        <label className="block">
          <span className="label">Valid for (days)</span>
          <input className="input num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Repaired value (optional)</span>
          <input className="input num" inputMode="numeric" value={repaired} onChange={(e) => setRepaired(e.target.value)} placeholder="if the app showed it" />
        </label>
      </div>
      <button className="btn btn-sm btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Save quote"}
      </button>
      <ErrorText error={err} />
    </form>
  );
}

/**
 * TRADE-IN — what the phone is worth as it is (the step's one figure: a quote from the partner's app
 * or live API, else PriceIQ at the grade less a % per defect, else the partner's rate card), and the
 * new phone it goes towards, with its bonus in one line. The quote's working, its source, a quote
 * read off the partner's app and the bonus in full are behind "Show details". What the customer
 * pays and how it compares with the repair are the answer's, not repeated here. The store's buy vs
 * sell is "Store margin · staff only" under the answer (StoreMargin.tsx); the partner sees what
 * the phone is worth once repaired instead.
 */
export function StepTradeIn({ ops, isPartner = false, isManager = false, bands = {} }: { ops: CaseOps; isPartner?: boolean; isManager?: boolean; bands?: Record<string, CampaignBand> }) {
  const { view, editable, act, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [requoting, setRequoting] = useState(false);
  const [typing, setTyping] = useState(false);
  const q = view.quote;
  const rq = view.repairedQuote;
  const priced = q?.status === "priced" && q.amount !== null;
  // A lapsed quote from the partner's app can't be re-quoted — only today's from the app replaces it.
  const lapsed = partnerQuoteLapsed(view);
  // The phone measured a size the Phone step doesn't list: the partner's quote for that size is the way on.
  const unlisted = unlistedSize(view);

  const needs: string[] = [];
  if (!view.device?.variant)
    needs.push(
      unlisted
        ? `Measures ${unlisted}, not on file — enter the app quote below.`
        : "Choose the model and storage first."
    );
  if (!view.condition) needs.push("Tick what's wrong first.");
  else if (view.conditionProblems.length) needs.push("Fix the condition first.");

  async function requote() {
    setRequoting(true);
    setErr(await act("reprice", { requote: true }));
    setRequoting(false);
  }

  // The partner-app form: wherever a quote from the app can stand; ON the step when nothing else will price the phone.
  const formAllowed = editable && (lapsed || (!view.partnerManual && !!(view.device?.variant || unlisted) && !!view.condition && view.conditionProblems.length === 0));
  const formNeeded = formAllowed && (lapsed || !!unlisted || q?.status === "unpriced" || q?.status === "error");
  const form = <PartnerQuoteForm ops={ops} measured={unlisted} />;

  // The step's one figure, and its one line.
  const figure = priced ? (
    <StepFigure tone={view.quoteExpired ? "muted" : undefined}>
      <Money value={q!.amount} />
    </StepFigure>
  ) : (
    <StepNoFigure>{!q ? "No trade-in price yet" : q.status === "error" ? "Partner didn't answer" : "No market price yet"}</StepNoFigure>
  );
  let line: string | null;
  let tone: "plain" | "warn" = "plain";
  if (!q) line = needs.length ? needs[0] : "Waiting for the partner.";
  else if (!priced) line = q.reason ?? null;
  else if (view.quoteExpired) {
    tone = "warn";
    line = lapsed
      ? `Expired ${fmtWhen(q.validUntil)} — enter today's quote below.`
      : `Expired ${fmtWhen(q.validUntil)} — re-quote first.`;
  } else if (q.source.kind === "priceiq") {
    // The answer's one line ("Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35"), and its
    // note when the market data is over 14 days old or PriceIQ didn't answer (the last good answer).
    const note = view.offer?.swap.tradeInNote ?? null;
    tone = note ? "warn" : "plain";
    line = [view.offer?.swap.tradeInDetail?.line ?? q.source.label, note ?? `valid until ${fmtWhen(q.validUntil)}`].join(" · ");
  } else line = `Partner's as-is price · valid until ${fmtWhen(q.validUntil)}`;

  const up = view.upgrade;
  // A PriceIQ trade-in starts from the store's SELL price: its trace is staff-only (the server sends the partner one line).
  const storeOnlyTrace = isPartner && q?.source.kind === "priceiq";
  const details = (
    <>
      {storeOnlyTrace ? null : q?.source.kind === "priceiq" ? (
        <p className="hint !mt-0">Market price at its grade − markdown − defects.</p>
      ) : view.partner ? (
        <p className="hint !mt-0">{view.partner.why}</p>
      ) : null}
      {priced && !storeOnlyTrace ? <Trace quote={q!} /> : null}

      {/* The partner: what the phone is worth once repaired, by its own price (store staff have the store margin under the answer) */}
      {isPartner && !storeOnlyTrace && view.faults.length > 0 && view.condition ? (
        <div>
          <div className="section-title">Worth once repaired</div>
          <div className="text-[18px] font-[720] mt-0.5">{rq?.status === "priced" ? <Money value={rq.amount} /> : <span className="text-muted">—</span>}</div>
          <div className="hint">
            {rq?.status === "priced"
              ? `${quoteSourceLabel(rq.source)} · not an offer`
              : rq?.reason
                ? rq.reason
                : q?.source.kind === "partner_manual"
                  ? "Not given — enter it from the app."
                  : "Not available."}
          </div>
        </div>
      ) : null}

      {/* A quote read off the partner's app */}
      {view.partnerManual ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="text-[14px] min-w-0">
            <div>
              <span className="font-semibold">From the partner app:</span> <Money value={view.partnerManual.amount} /> · ref{" "}
              <span className="num">{view.partnerManual.reference}</span>
              {view.partnerManual.repairedAmount !== null ? (
                <>
                  {" "}
                  · repaired <Money value={view.partnerManual.repairedAmount} />
                </>
              ) : null}
            </div>
            <div className="hint">
              By {view.partnerManual.by}, {fmtWhen(view.partnerManual.at)} · valid until {fmtWhen(view.partnerManual.validUntil)}
            </div>
          </div>
          {editable ? (
            <button type="button" className="btn btn-sm btn-danger" onClick={async () => setErr(await save({ partnerQuote: null }, { partnerManual: null }))}>
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
      {formAllowed && !formNeeded ? (
        typing ? (
          <div className="rounded-[12px] border border-line pt-3">{form}</div>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setTyping(true)}>
            Enter partner quote
          </button>
        )
      ) : null}
      {editable && q && !view.quoteExpired && !view.partnerManual ? (
        <button type="button" className="btn btn-sm btn-ghost !px-0 text-fix" onClick={requote} disabled={requoting}>
          {requoting ? "Re-quoting…" : "↻ Re-quote"}
        </button>
      ) : null}

      {up?.suggested && up.why ? <p className="text-[14px] text-ink-2">Suggested: {up.why}</p> : null}
      {up?.supportEndYear ? <p className="text-[14px] text-ink-2">Updates until {up.supportEndYear}</p> : null}
      <BonusDetails ops={ops} isManager={isManager} bands={bands} />
    </>
  );

  return (
    <StepCard id="step-tradein" title="Trade-in" figure={figure} line={line} lineTone={tone} details={details}>
      {/* Only what has to be done now: a re-quote, or a quote from the partner's app that nothing else can give */}
      {editable && priced && view.quoteExpired && !lapsed ? (
        <button type="button" className="btn btn-sm" onClick={requote} disabled={requoting}>
          {requoting ? "Re-quoting…" : "Re-quote"}
        </button>
      ) : null}
      {formNeeded ? (
        <div className="rounded-[12px] border border-line pt-3">
          <div className="px-4 font-semibold text-[15px]">{lapsed ? "Enter today's partner quote" : "Enter partner quote"}</div>
          {form}
        </div>
      ) : null}
      <NewPhone ops={ops} />
      <ErrorText error={err} />
    </StepCard>
  );
}
