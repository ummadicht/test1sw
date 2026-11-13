"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorText } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type { Offer } from "@/lib/domain/offer";
import type { AnswerLine, AnswerLineKey } from "@/lib/domain/answer";
import type { CaseOps } from "./ops";
import { CHOOSE_NEW_PHONE_LINK, askControl, autoRequoteKey, requotable, staleDecisionKey, swapRefusal, swapWhy } from "./answerAsks";
import { IdentityOverride } from "./AnswerAskForms";
import { GradeRow } from "./GradeRow";
import { RazorpayPaymentPanel } from "./RazorpayPaymentPanel";

/**
 * THE ANSWER, first, once the test is on the case (owner, 2026-10-17: "Why asking
 * questions when we have all tested data ... just refurb quote vs bonus + trade in price";
 * 2026-10-18: "Current grade C. Market price for grade C is ₹25000 … We pay you ₹27000 +
 * ₹10000 bonus if you exchange with a new device"):
 *
 *     Current grade C · screen cracked
 *     Market price for grade C ₹25,000
 *     Repair                        Swap up
 *     or repair it for ₹34,096      We pay you ₹26,000
 *                                   + ₹6,199 bonus if you exchange with a new device
 *
 * The LINES are the server's, word for word (CaseView.offer.answer, lib/domain/answer.ts) —
 * the same lines SwapUp Store and the customer's phone print; this card adds only the staff
 * extras under the line they belong to, and every figure and reason is the server's
 * (CaseView.offer, lib/domain/offer.ts). The repair and what we pay carry the same weight,
 * side by side, the recommended side marked. Whatever the test couldn't fill is one tap here (storage
 * chips with each size's trade-in) or a jump to the step that fills it — never a
 * guessed size, never a typed price. Where no step can fill it (the camera's identity
 * check) it is answered here (answerAsks.ts says which); where nothing can (no price, a
 * size not on file) it is said once, as text. An expired or unpriced quote is re-quoted
 * once on open, as the store app does, so "re-quoting" is true and a rate card uploaded
 * since shows. The verdict is decide()'s headline; the bonus is shown, never a reason.
 *
 * ONE ANSWER on the page — the case page's "The answer" step (caseSteps.ts): the headline,
 * its sentence, "Why this answer" (the server's signals and caveats, as the store app's "?"
 * sheet), the asks, the lines with their staff extras (the grade's report links, how the
 * market price was reached, the premium, the bonus, the new phone) and the buttons. Each
 * number once. Each ask and each "Change" goes to the step that answers it.
 */

/** "Cover: None · change" — the store app's short names. */
const COVER_SHORT: Record<Offer["repair"]["coverage"], string> = { none: "None", warranty: "Warranty", care_plus: "Care+" };

/** The store app's walk-away reasons, word for word. Optional. */
const WALK_AWAY_REASONS = ["Too expensive", "Will think about it", "Repairing elsewhere", "Other"] as const;

/** A storage chip: "256GB · ₹18,800", or just "512GB" when the partner has no price for that size. */
function chipLabel(opt: { variant: string; tradeIn: number | null }): string {
  return opt.tradeIn === null ? opt.variant : `${opt.variant} · ${inr(opt.tradeIn)}`;
}

/** One of the server's lines as sent: its text, and " · note" in muted ink. */
function LineText({ l }: { l: AnswerLine }) {
  return (
    <>
      {l.text}
      {l.note ? <span className="text-muted font-normal"> · {l.note}</span> : null}
    </>
  );
}

/** "Galaxy S26 Ultra 256GB ₹1,54,999 · customer pays ₹1,30,000" (the offer names the phone without the brand). */
function newPhoneLine(o: Offer): string | null {
  const p = o.swap.newPhone;
  if (!p) return null;
  const head = `${p.label} ${inr(p.price)}`;
  return o.swap.customerPays === null ? head : `${head} · customer pays ${inr(o.swap.customerPays)}`;
}

/** The swap against the repair, in what the customer pays today (+ = the swap costs more). */
function vsRepairLine(n: number | null): string | null {
  if (n === null) return null;
  if (n > 0) return `${inr(n)} more than repair`;
  if (n < 0) return `${inr(-n)} less than repair`;
  return "Same as repair";
}

function Small({ children, tone }: { children: ReactNode; tone?: "ink" | "warn" }) {
  const cls = tone === "ink" ? "text-ink" : tone === "warn" ? "text-warn font-semibold" : "text-muted";
  return <p className={`text-[13.5px] leading-snug ${cls}`}>{children}</p>;
}

/** A quiet link inside a tile ("Change", "Cover: None · change", "Re-quote"). */
function TileLink({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="self-start text-left text-[13.5px] font-semibold text-fix hover:underline disabled:opacity-60 disabled:no-underline no-print"
    >
      {children}
    </button>
  );
}

/**
 * One of the two numbers. Both stay side by side at phone width (each may shrink below its
 * content). The small "Recommended" is the desk's blue, only for a repair or upgrade verdict.
 */
function Tile({ label, recommended, children }: { label: string; recommended: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 min-w-0 rounded-[12px] border-[1.5px] px-3 py-3 sm:px-4 sm:py-4 ${recommended ? "border-[color:var(--ink)]" : "border-line"}`}>
      {recommended ? <div className="text-[12px] font-bold text-fix">Recommended</div> : null}
      <div className="section-title">{label}</div>
      {children}
    </div>
  );
}

/**
 * "Why this answer" — the server's signals and caveats, word for word, as the store app's
 * "?" sheet lays them out. Closed by default; not there when the server gives none.
 */
function WhyThisAnswer({ o }: { o: Offer }) {
  // The headline's own sentence is already on the card: not said twice.
  const signals = o.signals.filter((x) => x.text !== o.reason);
  if (!signals.length && !o.caveats.length) return null;
  return (
    <details className="mt-1.5 group">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-block text-[13.5px] font-semibold text-fix hover:underline no-print">
        Why this answer <span aria-hidden className="inline-block group-open:rotate-90 transition-transform">›</span>
      </summary>
      <div className="mt-2 space-y-2.5 rounded-[12px] bg-surface-2 px-4 py-3">
        {signals.map((x, i) => (
          <div key={`s${i}`}>
            <div className={`text-[12px] font-bold uppercase tracking-wider ${x.points === "repair" ? "text-fix" : "text-ink"}`}>
              Points to {x.points === "repair" ? "repair" : "upgrade"} · {x.strength}
            </div>
            <p className="text-[14px] text-ink leading-snug">{x.text}</p>
          </div>
        ))}
        {o.caveats.length ? (
          <div>
            <div className="section-title">Good to know</div>
            <ul className="mt-0.5 list-disc pl-5 text-[13.5px] text-ink-2 space-y-0.5">
              {o.caveats.map((c, i) => (
                <li key={`c${i}`}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * How the market price was reached, in the server's words (Offer.swap.tradeInDetail) — closed
 * behind "Show details", as the store app's: its one line ("Refurbished market price ₹51,399 (Good)
 * − 2% − 2 defects · PriceIQ") and each step with its % and rupees. Nothing for a single figure.
 */
function TradeInHow({ d }: { d: NonNullable<Offer["swap"]["tradeInDetail"]> }) {
  if (!d.line && !d.lines.length && !d.note) return null;
  return (
    <>
      {d.line || d.lines.length || d.note ? (
        <details className="group">
          <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-block text-[13.5px] font-semibold text-fix hover:underline">
            Show details <span aria-hidden className="inline-block group-open:rotate-90 transition-transform">›</span>
          </summary>
          {d.line ? <p className="mt-1.5 text-[13px] text-ink-2 leading-snug">{d.line}</p> : null}
          <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
            {d.lines.map((l, i) => (
              <li key={`${l.label}-${i}`} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0">
                  {l.label}
                  {l.pct ? <span className="text-muted"> · {l.pct}</span> : null}
                </span>
                <span className="num whitespace-nowrap">{l.amount > 0 && i > 0 ? `+${inr(l.amount)}` : inr(l.amount)}</span>
              </li>
            ))}
          </ul>
          {d.note ? <p className="mt-1.5 text-[13px] text-muted leading-snug">{d.note}</p> : null}
        </details>
      ) : null}
    </>
  );
}

/** The repair and what we pay: the same weight, side by side. */
const FIGURE = "num text-[19px] sm:text-[26px] font-[760] leading-tight tracking-tight [overflow-wrap:anywhere]";

export function AnswerCard({
  ops,
  isManager,
  onStep,
  onSwap,
}: {
  ops: CaseOps;
  /** The store manager: the only one who may accept a phone the camera says isn't the one on the case. */
  isManager: boolean;
  /** Go to the step that answers it ("step-phone", "step-repair", … — caseSteps.ts stepFromAnchor). */
  onStep: (id: string) => void;
  /** "Swap up": show the lock form and go to it. */
  onSwap: () => void;
}) {
  const { view, busy, save, act, editable } = ops;
  const [confirm, setConfirm] = useState<null | "repair" | "walk">(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [requoting, setRequoting] = useState(false);
  const [requoteErr, setRequoteErr] = useState<string | null>(null);

  // An expired or unpriced quote is re-quoted once, quietly, the moment the answer shows it (the
  // store app's answer screen does the same): ONCE per page open, whatever comes back — a quote
  // already out of date, or still unpriced, is not asked for again and again with the IMEI. The
  // tile's "Re-quote" is the way to ask again (autoRequoteKey).
  // An open case decided under an older ruleset is re-decided the same quiet way, without asking the partner.
  const autoKey = autoRequoteKey(view) ?? staleDecisionKey(view);
  const autoTried = useRef(false);
  useEffect(() => {
    if (!editable || !autoKey || autoTried.current) return;
    autoTried.current = true;
    setRequoting(true);
    void act("reprice").then((e) => {
      setRequoting(false);
      setRequoteErr(e);
    });
  }, [editable, autoKey, act]);

  const o = view.offer;
  if (!o) return null;

  async function requote() {
    setRequoting(true);
    const e = await act("reprice", { requote: true });
    setRequoting(false);
    setRequoteErr(e);
  }

  async function run(action: string, extra?: Record<string, unknown>) {
    setActing(true);
    const e = await act(action, extra);
    setActing(false);
    setErr(e);
    if (!e) setConfirm(null);
  }

  async function pickVariant(v: string) {
    if (!view.device) return;
    setErr(await save({ variant: v }, { device: { ...view.device, variant: v } }));
  }

  const badge = o.recommendation === "repair" ? "repair" : o.recommendation === "upgrade" ? "swap" : null;

  // Refurb quote — defaults to ₹5,000 when no specific repair quote is set so customer can always opt to repair via Razorpay.
  const r = o.repair;
  const effectiveRepairAmount = r.amount !== null && r.amount > 0 ? r.amount : 5000;
  const repairWhy = r.amount === null && !r.nothingToRepair ? r.why : null;
  const repairRefusal = o.actions.repair && o.actions.repair !== repairWhy && !(r.nothingToRepair && o.actions.repair === r.why) ? o.actions.repair : null;
  // The server's lines, and its staff-only words.
  const line = (k: AnswerLineKey) => o.answer.lines.find((l) => l.key === k) ?? null;
  const [gradeL, marketL, wePayL, bonusL, repairL] = (["grade", "market", "we_pay", "bonus", "repair"] as const).map(line);
  const notes = o.answer.staffNotes;
  // Swap up
  const w = o.swap;
  const phoneLine = newPhoneLine(o);
  const vs = vsRepairLine(w.vsRepair);
  // Said once: not again when the headline's sentence already says it (a phone not on the card).
  const swapNoPrice = swapWhy(o);
  const swapNo = swapRefusal(o);

  return (
    <section className="card" id="answer" aria-label="The answer">
      <div className="px-5 pt-4 pb-4 space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="section-title">The answer</div>
            {busy ? (
              <span className="text-[12px] font-semibold text-muted" aria-live="polite">
                Updating…
              </span>
            ) : null}
          </div>
          <h2 className="text-[24px] sm:text-[28px] font-[760] leading-tight tracking-tight mt-1">{o.headline}</h2>
          {o.reason ? <p className="text-[15px] text-ink-2 leading-snug mt-1">{o.reason}</p> : null}
          {/* A safety warning is never behind "Why this answer". */}
          {o.safety ? <p className="text-[14px] text-warn font-semibold leading-snug mt-1.5" role="alert">{o.safety}</p> : null}
          {o.storage.note ? <p className="text-[13.5px] text-warn font-semibold leading-snug mt-1.5">{o.storage.note}</p> : null}
          <WhyThisAnswer o={o} />
        </div>

        {/* What the answer still needs — one tap each. Title and text are dropped where the headline and the sentence already say them. */}
        {o.asks.map((a) => {
          const c = askControl(a, view, isManager);
          const control =
            c.kind === "chips" ? (
              <>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Storage">
                  {c.options.map((opt) => (
                    <button key={opt.variant} type="button" className="chip num" aria-pressed={view.device?.variant === opt.variant} disabled={busy} onClick={() => pickVariant(opt.variant)}>
                      {chipLabel(opt)}
                    </button>
                  ))}
                </div>
                {/* The market data's age, or "PriceIQ unreachable, last answer …", while those chip prices are on screen. */}
                {c.note ? <Small tone="warn">{c.note}</Small> : null}
              </>
            ) : c.kind === "identity_override" ? (
              <IdentityOverride ops={ops} />
            ) : c.kind === "ask_manager" ? (
              <Small tone="ink">{c.text}</Small>
            ) : c.kind === "step" ? (
              <button type="button" className="btn btn-sm" onClick={() => onStep(c.step)}>
                {c.button}
              </button>
            ) : null;
          const title = a.title !== o.headline ? a.title : null;
          const text = a.text !== o.reason ? a.text : null;
          if (!title && !text && !control) return null;
          return (
            <div key={a.kind} className="rounded-[12px] border border-line bg-surface-2 px-4 py-3 space-y-2">
              {title ? <div className="text-[15px] font-[720] leading-tight">{title}</div> : null}
              {text ? <p className="text-[14px] text-ink-2 leading-snug">{text}</p> : null}
              {control}
            </div>
          );
        })}

        {/* The grade and the market price — the server's lines; the grade's report and how the price was reached under them. */}
        {gradeL || marketL || view.grading ? (
          <div className="rounded-[12px] border border-line px-4 py-3 space-y-3">
            {gradeL || view.grading ? (
              <div className="space-y-1">
                {gradeL ? (
                  <p className="text-[16px] font-[720] leading-snug">
                    <LineText l={gradeL} />
                  </p>
                ) : null}
                {/* The grade never moves a price (docs/GRADING.md): its report and why sit under the line, never in the money. */}
                {view.grading ? <GradeRow view={view} hideLabel={!!gradeL} /> : null}
              </div>
            ) : null}
            {marketL ? (
              <div className="space-y-1">
                <p className="text-[16px] font-[720] leading-snug">
                  <LineText l={marketL} />
                </p>
                {notes.market ? <Small tone="warn">{notes.market}</Small> : null}
                {w.tradeInNote ? <Small tone="warn">{w.tradeInNote}</Small> : null}
                {w.tradeInDetail ? <TradeInHow d={w.tradeInDetail} /> : null}
                {/* The quiet re-quote is the usual way out; this is for when it failed or the advisor wants it now. */}
                {editable && requotable(view) ? (
                  <>
                    <TileLink onClick={requote} disabled={requoting}>
                      {requoting ? "Re-quoting…" : "Re-quote"}
                    </TileLink>
                    {requoteErr ? <Small tone="warn">{requoteErr}</Small> : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Repair | Swap up — the same weight, side by side even on a phone */}
        <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
          <Tile label="Repair" recommended={badge === "repair"}>
            {repairL && repairL.amount !== null && (repairL.amount > 0 || r.covered) ? (
              <div className={FIGURE}>{repairL.text}</div>
            ) : (
              <div className={FIGURE}>or repair it for {inr(effectiveRepairAmount)}</div>
            )}
            {r.amount !== null && r.detail ? (
              <Small>{r.detail}</Small>
            ) : (
              <Small>Standard service estimate ({inr(effectiveRepairAmount)} default)</Small>
            )}
            {repairWhy ? <Small>{repairWhy}</Small> : null}
            {editable && repairRefusal ? <Small tone="ink">{repairRefusal}</Small> : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <TileLink onClick={() => onStep("step-repair")}>Open full case</TileLink>
              <TileLink onClick={() => onStep("step-repair")}>Change</TileLink>
            </div>
            <p className="text-[13.5px] text-ink-2">
              Cover: {COVER_SHORT[r.coverage]} · <TileLink onClick={() => onStep("step-phone")}>change</TileLink>
            </p>
          </Tile>

          <Tile label="Swap up" recommended={badge === "swap"}>
            <div className={`${FIGURE} ${wePayL ? "" : "text-muted"}`}>{wePayL ? wePayL.text : "—"}</div>
            {bonusL ? (
              <p className="text-[15px] text-ink leading-snug">
                <LineText l={bonusL} />
              </p>
            ) : null}
            {swapNoPrice ? <Small>{swapNoPrice}</Small> : null}
            {notes.we_pay ? <Small>{notes.we_pay}</Small> : null}
            {wePayL && notes.bonus ? <Small>{notes.bonus}</Small> : null}
            {phoneLine ? (
              <div className="flex flex-col gap-1 mt-0.5">
                {w.newPhone?.suggested ? (
                  <span className="pill pill-fix self-start" title={w.newPhone.why ?? undefined}>
                    Suggested
                  </span>
                ) : null}
                <Small tone="ink">{phoneLine}</Small>
                <TileLink onClick={() => onStep("step-upgrade")}>Change</TileLink>
              </div>
            ) : (
              <TileLink onClick={() => onStep("step-upgrade")}>{CHOOSE_NEW_PHONE_LINK}</TileLink>
            )}
            {vs ? <Small>{vs}</Small> : null}
            {editable && swapNo ? <Small tone="ink">{swapNo}</Small> : null}
          </Tile>
        </div>

        <RazorpayPaymentPanel
          caseId={view.id}
          caseRef={view.ref}
          mode={w.customerPays !== null && w.customerPays > 0 ? "both" : "repair"}
          repairAmount={effectiveRepairAmount}
          swapAmount={w.customerPays}
          customerName={view.customer?.name}
          customerPhone={view.customer?.phone}
        />
      </div>

      {/* What the customer chose — at the counter only; a closed or read-only case has nothing to choose */}
      {editable ? (
      <div className="border-t border-line px-5 py-3 space-y-2 rounded-b-[14px] no-print">
        {confirm === "repair" ? (
          <div className="rounded-[12px] border border-line p-3 space-y-3">
            <div className="text-[14px] font-semibold">Closes the case for repair ({inr(effectiveRepairAmount)}). Customer can pay Part Advance or Full amount via Razorpay:</div>
            <RazorpayPaymentPanel
              caseId={view.id}
              caseRef={view.ref}
              mode="repair"
              repairAmount={effectiveRepairAmount}
              swapAmount={w.customerPays}
              customerName={view.customer?.name}
              customerPhone={view.customer?.phone}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-fix btn-sm" disabled={acting} onClick={() => run("choose_repair")}>
                {acting ? "Closing…" : "Confirm: Customer will repair"}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={acting} onClick={() => setConfirm(null)}>
                Not yet
              </button>
            </div>
          </div>
        ) : confirm === "walk" ? (
          <div className="rounded-[12px] border border-line p-3 space-y-2">
            <div className="text-[14px] font-semibold">Closes the case. Why? (optional)</div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Why they left (optional)">
              {WALK_AWAY_REASONS.map((x) => (
                <button key={x} type="button" className="chip" aria-pressed={reason === x} onClick={() => setReason((cur) => (cur === x ? "" : x))}>
                  {x}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" disabled={acting} onClick={() => run("walk_away", reason ? { reason } : {})}>
                {acting ? "Closing…" : "Customer walked away"}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={acting} onClick={() => setConfirm(null)}>
                Not yet
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn btn-fix !whitespace-normal !px-3 leading-tight"
                disabled={busy}
                onClick={() => {
                  setErr(null);
                  setConfirm("repair");
                }}
              >
                Customer will repair ({inr(effectiveRepairAmount)})
              </button>
              <button type="button" className="btn btn-up !whitespace-normal !px-3 leading-tight" disabled={o.actions.swap !== null} title={o.actions.swap ?? undefined} onClick={onSwap}>
                Swap up
              </button>
            </div>
            {o.actions.walkAway === null ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm w-full"
                onClick={() => {
                  setErr(null);
                  setReason("");
                  setConfirm("walk");
                }}
              >
                Customer walked away
              </button>
            ) : null}
          </>
        )}
        <ErrorText error={err} />
      </div>
      ) : null}
    </section>
  );
}
