"use client";

import { useState } from "react";
import { Money, Pct, Banner, SourceBadge, ErrorText } from "@/components/ui";
import type { PartnerQuote } from "@/lib/server/buyback";
import { buySell } from "@/lib/domain/buySell";
import { StepCard } from "./StepCard";
import { fmtWhen } from "./shared";
import type { CaseOps } from "./ops";
import { cashifyLapsed, unlistedSize } from "./answerAsks";

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

/**
 * The quote read off the partner's own app, with its reference code — binding as entered.
 * `measured`: the phone measured a size that isn't on the model's list, and the case has no
 * storage — the quote is for that size and settles the storage at it (cases.ts updateCase).
 */
function PartnerQuoteForm({ ops, partner, measured = null }: { ops: CaseOps; partner: string; measured?: string | null }) {
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
        {measured ? ` The phone measures ${measured}: price it at ${measured} in the app, and the case's storage is set to ${measured}.` : null}
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

function LedgerRow({ label, sub, strong, stack, children }: { label: string; sub: React.ReactNode; strong?: boolean; stack?: boolean; children: React.ReactNode }) {
  // `stack`: the value goes under the label on a phone (an input needs the width).
  const cols = stack ? "grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]";
  return (
    <div className={`grid ${cols} items-center gap-x-4 px-4 py-3 ${strong ? "bg-surface-2" : ""}`}>
      <dt className="min-w-0">
        <div className={strong ? "text-[15px] font-bold" : "text-[14px] font-semibold"}>{label}</div>
        {sub ? <div className="text-[12.5px] text-muted leading-snug mt-0.5">{sub}</div> : null}
      </dt>
      <dd className={`${stack ? "sm:text-right" : "text-right"} ${strong ? "text-[24px] font-[760] tracking-tight" : "text-[17px] font-semibold"}`}>{children}</dd>
    </div>
  );
}

/**
 * BUY vs SELL — the store's numbers for this trade-in (lib/domain/buySell.ts):
 * what it pays the customer, what the refurb costs, what it sells for once
 * refurbished (PriceIQ's Cashify listing less 2–5%), and the margin. The refurb
 * cost is the advisor's to set; it is saved as the case's refurbCost — the
 * store's own figure, which moves no price — exactly as the SwapUp Store app does.
 */
function BuySellBlock({ ops, partner }: { ops: CaseOps; partner: string }) {
  const { view, editable, save } = ops;
  const q = view.quote;
  const rq = view.repairedQuote;
  const m = view.marketSell;
  const b = buySell({ quote: q, repairedQuote: rq, refurbCost: view.refurbCost, repair: view.repair, faultCount: view.faults.length, market: m, partner });
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = draft ?? (b.refurb === null ? "" : String(b.refurb));
  const typed = Number(shown.replace(/[,\s₹]/g, ""));
  const changed = draft !== null && shown.trim() !== "" && typed !== b.refurb;

  async function saveRefurb(e: React.FormEvent) {
    e.preventDefault();
    if (!shown.trim() || !Number.isInteger(typed) || typed < 0 || typed > 500_000) return setErr("Enter the refurb cost as a whole rupee amount.");
    setSaving(true);
    const e2 = await save({ refurbCost: { amount: typed } });
    setSaving(false);
    setErr(e2);
    if (!e2) setDraft(null);
  }

  const refurbSub =
    b.refurbBasis === "quote" && view.refurbCost
      ? `Entered by ${view.refurbCost.by}`
      : b.refurbBasis === "estimate"
        ? "SwapUp's repair estimate at list price (step 4)"
        : b.refurbBasis === "none"
          ? "Nothing to repair"
          : b.refurbWhy;
  const sellSub =
    b.sellBasis === "market" && m.amount !== null
      ? `Cashify sells it refurbished from ₹${m.listing.toLocaleString("en-IN")} (${m.grade}${m.grade !== m.gradeWanted ? `, none listed at ${m.gradeWanted}` : ""}) − ${m.markdownBp / 100}% · PriceIQ ${m.week}`
      : b.sellBasis === "partner"
        ? `${partner}'s price repaired — PriceIQ: ${m.why ?? "no Cashify listing"}`
        : rq?.reason
        ? rq.reason
        : q?.source.kind === "partner_manual"
          ? `Only ${partner}'s real rate card may give a repaired value next to a quote from its app — enter it from the app if it showed one.`
          : b.sellWhy;

  return (
    <section className="mt-4 rounded-[12px] border border-line overflow-hidden" aria-label="Buy vs sell">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line">
        <div className="section-title">Buy vs sell</div>
        <span className="text-[12px] text-muted">For the store — not an offer to the customer</span>
      </div>
      <dl className="divide-y divide-[color:var(--line)]">
        <LedgerRow label="Buy — pay the customer" sub={b.buy !== null ? `${partner}'s price as it is` : b.buyWhy}>
          <Money value={b.buy} />
        </LedgerRow>
        <LedgerRow label="Store's refurb cost" sub={refurbSub} stack={editable}>
          {editable ? (
            <form onSubmit={saveRefurb} className="flex items-center sm:justify-end gap-2">
              <span className="text-muted text-[15px]" aria-hidden>
                ₹
              </span>
              <input
                className="input num !min-h-[38px] !py-1.5 w-[110px] text-right"
                inputMode="numeric"
                aria-label="Store's refurb cost in rupees"
                value={shown}
                placeholder="—"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setErr(null);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={!changed || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </form>
          ) : (
            <Money value={b.refurb} />
          )}
        </LedgerRow>
        <LedgerRow label="Sell — after refurb" sub={sellSub}>
          <Money value={b.sell} />
        </LedgerRow>
        <LedgerRow label="Margin" sub={b.margin !== null ? "Sell − buy − refurb cost" : b.marginWhy} strong>
          <Money value={b.margin} className={b.margin !== null && b.margin < 0 ? "text-bad" : ""} />
        </LedgerRow>
      </dl>
      {err ? (
        <div className="px-4 pb-3">
          <ErrorText error={err} />
        </div>
      ) : null}
    </section>
  );
}

/** ⑤ What the buyback partner pays for the phone as it is — and, for the store, buy vs sell once repaired. */
export function StepTradeIn({ ops, showBuySell = true }: { ops: CaseOps; showBuySell?: boolean }) {
  const { view, editable, act, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [requoting, setRequoting] = useState(false);
  const q = view.quote;
  const rq = view.repairedQuote;
  const partner = q?.partner ?? view.partner?.partnerName ?? "The partner";
  const priced = q?.status === "priced" && q.amount !== null;
  const done = priced && !view.quoteExpired;
  // A lapsed quote from the partner's app can't be re-quoted — only today's from the app replaces it.
  const lapsed = cashifyLapsed(view);
  // The phone measured a size step 1 doesn't list: the partner's quote for that size is the way on.
  const unlisted = unlistedSize(view);

  const needs: string[] = [];
  if (!view.device?.variant)
    needs.push(
      unlisted
        ? `The phone measures ${unlisted}, which isn't a size on file. If Settings › About phone shows ${unlisted}, enter the quote from the ${partner} app here; if it doesn't, choose the storage (step 1).`
        : "Choose the model and storage (step 1)."
    );
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
                {lapsed ? (
                  <>This quote from the {partner} app has expired. SwapUp can&apos;t re-quote it — enter today&apos;s quote from the app below before taking the phone.</>
                ) : (
                  <>
                    This quote has expired. Re-quote before taking the phone — the price may have changed.
                    {editable ? (
                      <div className="mt-2">
                        <button type="button" className="btn btn-sm" onClick={requote} disabled={requoting}>
                          {requoting ? "Re-quoting…" : "Re-quote"}
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </Banner>
            </div>
          ) : null}
          <Trace quote={q} partner={partner} />
        </div>
      )}

      {/* Buy vs sell (store staff), or — for the partner — the repaired value alone */}
      {showBuySell ? (
        q ? <BuySellBlock ops={ops} partner={partner} /> : null
      ) : view.faults.length > 0 && view.condition ? (
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
      ) : null}
      {/* The form: no quote from the app yet (the phone described, or measured at a size step 1 doesn't list), or the one on file has lapsed */}
      {editable && (lapsed || (!view.partnerManual && (view.device?.variant || unlisted) && view.condition && view.conditionProblems.length === 0)) ? (
        <details className="mt-4 rounded-[12px] border border-line" open={lapsed || !!unlisted || q?.status === "unpriced" || q?.status === "error"}>
          <summary className="cursor-pointer px-4 py-3 text-[14px] font-semibold">
            {lapsed ? `Enter today's quote from the ${partner} app` : `Enter the quote from the ${partner} app`}
          </summary>
          <PartnerQuoteForm ops={ops} partner={partner} measured={unlisted} />
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
