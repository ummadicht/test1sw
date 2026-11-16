"use client";

import { useState } from "react";
import { Money, Pct, SourceBadge, ErrorText } from "@/components/ui";
import type { PartnerQuote } from "@/lib/server/buyback";
import { StepCard, StepFigure, StepNoFigure } from "./StepCard";
import { NewPhone, BonusDetails, estimateNetCustomerPays } from "./StepUpgrade";
import { RazorpayPaymentPanel } from "./RazorpayPaymentPanel";
import { fmtWhen } from "./shared";
import type { CaseOps, CampaignBand } from "./ops";
import { requoteSpot, unlistedSize } from "./answerAsks";
import { quoteSourceLabel, retiredSource } from "@/lib/domain/ratecard";
import { noPriceWhy } from "@/lib/domain/offer";
import { inr } from "@/lib/domain/money";

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
 * TRADE-IN — what the phone is worth as it is, and the new phone it goes towards, with its
 * bonus and updated net payable balance.
 */
export function StepTradeIn({
  ops,
  isPartner = false,
  isManager = false,
  bands = {},
  onSwap,
  onAnswer,
}: {
  ops: CaseOps;
  isPartner?: boolean;
  isManager?: boolean;
  bands?: Record<string, CampaignBand>;
  onSwap?: () => void;
  onAnswer?: () => void;
}) {
  const { view, editable, act } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [requoting, setRequoting] = useState(false);
  const q = view.quote;
  const rq = view.repairedQuote;
  const priced = q?.status === "priced" && q.amount !== null;
  const unlisted = unlistedSize(view);
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

  const up = view.upgrade;
  const est = up
    ? estimateNetCustomerPays(up.price ?? 0, view.offer?.swap.wePay ?? q?.amount, view.offer?.swap.bonus)
    : null;
  const effectiveCustomerPays =
    view.offer?.swap.customerPays !== null && view.offer?.swap.customerPays !== undefined
      ? view.offer.swap.customerPays
      : (est?.customerPays ?? null);

  // The step's one figure, and its one line.
  const figure = priced ? (
    <StepFigure tone={view.quoteExpired ? "muted" : undefined}>
      <Money value={q!.amount} />
    </StepFigure>
  ) : up && effectiveCustomerPays !== null ? (
    <StepFigure>
      <Money value={effectiveCustomerPays} />
    </StepFigure>
  ) : (
    <StepNoFigure>{!q ? "No trade-in price yet" : q.status === "error" ? "Partner didn't answer" : "No market price yet"}</StepNoFigure>
  );
  let line: string | null;
  let tone: "plain" | "warn" = "plain";
  if (!q) line = needs.length ? needs[0] : "Waiting for the partner.";
  else if (!priced) line = noPriceWhy(q.reason);
  else if (view.quoteExpired) {
    tone = "warn";
    line = `Expired ${fmtWhen(q.validUntil)} — re-quote first.`;
  } else if (q.source.kind === "priceiq") {
    const note = view.offer?.swap.tradeInNote ?? null;
    tone = note ? "warn" : "plain";
    const baseLine = [view.offer?.swap.tradeInDetail?.line ?? q.source.label, note ?? `valid until ${fmtWhen(q.validUntil)}`].join(" · ");
    line = up && effectiveCustomerPays !== null ? `${baseLine} · Customer pays ${inr(effectiveCustomerPays)} for ${up.model} ${up.variant}` : baseLine;
  } else {
    const baseLine = `Partner's as-is price · valid until ${fmtWhen(q.validUntil)}`;
    line = up && effectiveCustomerPays !== null ? `${baseLine} · Customer pays ${inr(effectiveCustomerPays)} for ${up.model} ${up.variant}` : baseLine;
  }

  const storeOnlyTrace = isPartner && q?.source.kind === "priceiq";
  const details = (
    <>
      {storeOnlyTrace ? null : q?.source.kind === "priceiq" ? (
        <p className="hint !mt-0">Market price at its grade − markdown − defects.</p>
      ) : view.partner ? (
        <p className="hint !mt-0">{view.partner.why}</p>
      ) : null}
      {priced && !storeOnlyTrace ? <Trace quote={q!} /> : null}

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
      {retry === "step" ? (
        <button type="button" className="btn btn-sm" onClick={requote} disabled={requoting}>
          {requoting ? "Re-quoting…" : "Re-quote"}
        </button>
      ) : null}
      <NewPhone ops={ops} onSwap={onSwap} />

      {!isPartner && up && effectiveCustomerPays !== null && effectiveCustomerPays > 0 ? (
        <div className="mt-4 space-y-3">
          <RazorpayPaymentPanel
            caseId={view.id}
            caseRef={view.ref}
            mode="swap"
            repairAmount={view.offer?.repair.amount ?? null}
            swapAmount={effectiveCustomerPays}
            customerName={view.customer?.name}
            customerPhone={view.customer?.phone}
          />
          {editable && (onSwap || onAnswer) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {onAnswer ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={onAnswer}>
                  ← Back to The Answer
                </button>
              ) : null}
              {onSwap ? (
                <button type="button" className="btn btn-up ml-auto" onClick={onSwap}>
                  Swap up (Complete payment · <Money value={effectiveCustomerPays} />)
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <ErrorText error={err} />
    </StepCard>
  );
}
