"use client";

import { useState } from "react";
import { Money, Pct, SourceBadge, ErrorText } from "@/components/ui";
import type { PartnerQuote } from "@/lib/server/buyback";
import { StepCard, StepFigure, StepNoFigure } from "./StepCard";
import { NewPhone, BonusDetails } from "./StepUpgrade";
import { fmtWhen } from "./shared";
import type { CaseOps, CampaignBand } from "./ops";
import { requoteSpot, unlistedSize } from "./answerAsks";
import { quoteSourceLabel, retiredSource } from "@/lib/domain/ratecard";
import { noPriceWhy } from "@/lib/domain/offer";

/** SourceBadge for a quote: where its price came from. */
export function QuoteSource({ quote }: { quote: Pick<PartnerQuote, "source"> | null | undefined }) {
  if (!quote) return null;
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
 * TRADE-IN — what the phone is worth as it is (the step's one figure: PriceIQ at the grade less a
 * % per defect, else the partner's rate card — the system's price, never a typed one; what's wrong
 * with the phone is the only thing that changes it), and the new phone it goes towards, with its
 * bonus in one line. The quote's working, its source and the bonus in full are behind "Show
 * details". What the customer pays and how it compares with the repair are the answer's, not
 * repeated here. The store's buy vs sell is "Store margin · staff only" under the answer
 * (StoreMargin.tsx); the partner sees what the phone is worth once repaired instead.
 */
export function StepTradeIn({ ops, isPartner = false, isManager = false, bands = {} }: { ops: CaseOps; isPartner?: boolean; isManager?: boolean; bands?: Record<string, CampaignBand> }) {
  const { view, editable, act } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [requoting, setRequoting] = useState(false);
  const q = view.quote;
  const rq = view.repairedQuote;
  const priced = q?.status === "priced" && q.amount !== null;
  // The phone measured a size the Phone step doesn't list: nothing prices that size, and none is guessed.
  const unlisted = unlistedSize(view);
  // The one Re-quote: on the step when the price expired or nothing priced it, else in the details.
  const retry = requoteSpot(view, editable);

  const needs: string[] = [];
  if (!view.device?.variant)
    needs.push(unlisted ? `Phone measures ${unlisted}, not on file — no trade-in price for that size.` : "Choose the model and storage first.");
  if (!view.condition) needs.push("Tick what's wrong first.");
  else if (view.conditionProblems.length) needs.push("Fix the condition first.");

  async function requote() {
    setRequoting(true);
    setErr(await act("reprice", { requote: true }));
    setRequoting(false);
  }

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
  // Why nothing priced it — never "No market price yet" again under that figure.
  else if (!priced) line = noPriceWhy(q.reason);
  else if (view.quoteExpired) {
    tone = "warn";
    line = `Expired ${fmtWhen(q.validUntil)} — re-quote first.`;
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
            {rq?.status === "priced" ? `${quoteSourceLabel(rq.source)} · not an offer` : (rq?.reason ?? "Not available.")}
          </div>
        </div>
      ) : null}

      {retry === "details" ? (
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
      {/* Only what has to be done now: re-quote an expired price, or ask again where nothing priced it */}
      {retry === "step" ? (
        <button type="button" className="btn btn-sm" onClick={requote} disabled={requoting}>
          {requoting ? "Re-quoting…" : "Re-quote"}
        </button>
      ) : null}
      <NewPhone ops={ops} />
      <ErrorText error={err} />
    </StepCard>
  );
}
