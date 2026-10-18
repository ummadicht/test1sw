"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorText } from "@/components/ui";
import { inr, fmtBp } from "@/lib/domain/money";
import type { Offer } from "@/lib/domain/offer";
import type { CaseOps } from "./ops";
import { CHOOSE_NEW_PHONE_LINK, askControl, autoRequoteKey, requotable, swapRefusal } from "./answerAsks";
import { PartnerQuoteEntry, IdentityOverride } from "./AnswerAskForms";
import { GradeRow } from "./GradeRow";

/**
 * THE ANSWER, first, once the test is on the case (owner, 2026-10-17: "Why asking
 * questions when we have all tested data ... just refurb quote vs bonus + trade in price"):
 *
 *     Refurb quote          vs     Trade-in + bonus
 *     what fixing it costs         the as-is price + the upgrade bonus
 *
 * The same numbers and the same words as the SwapUp Store answer screen: the server
 * builds every figure and every reason (CaseView.offer, lib/domain/offer.ts) and this
 * card only lays them out. Whatever the test couldn't fill is one tap here (storage
 * chips with each size's trade-in) or a jump to the step that fills it — never a
 * guessed size. Where no step can fill it (a lapsed partner-app quote, a size not on
 * file, the camera's identity check) it is answered here (answerAsks.ts says which). An
 * expired quote is re-quoted once on open, as the store app does, so "re-quoting" is
 * true. The verdict is decide()'s headline; the bonus is shown, never a reason.
 *
 * ONE ANSWER on the page — the case page's "The answer" step (caseSteps.ts): the headline,
 * its sentence, "Why this answer" (the server's signals and caveats, as the store app's "?"
 * sheet), the SwapUp grade on one line (GradeRow), the asks, the two tiles and the buttons.
 * Each ask and each "Change" goes to the step that answers it. No second money panel.
 */

/** "Cover: None · change" — the store app's short names. */
const COVER_SHORT: Record<Offer["repair"]["coverage"], string> = { none: "None", warranty: "Warranty", care_plus: "Care+" };

/** The store app's walk-away reasons, word for word. Optional. */
const WALK_AWAY_REASONS = ["Too expensive", "Will think about it", "Repairing elsewhere", "Other"] as const;

/** A storage chip: "256GB · ₹18,800", or just "512GB" when the partner has no price for that size. */
function chipLabel(opt: { variant: string; tradeIn: number | null }): string {
  return opt.tradeIn === null ? opt.variant : `${opt.variant} · ${inr(opt.tradeIn)}`;
}

/** "Trade-in ₹18,800 + bonus ₹6,199 (4%)", or "Trade-in ₹18,800 · <why no bonus>". null without a trade-in — the tile says why instead. */
function bonusLine(o: Offer): string | null {
  const s = o.swap;
  if (s.tradeIn === null) return null;
  const trade = `Trade-in ${inr(s.tradeIn)}`;
  if (s.bonus !== null && s.bonus > 0) return `${trade} + bonus ${inr(s.bonus)}${s.bonusBp !== null ? ` (${fmtBp(s.bonusBp)})` : ""}`;
  return s.bonusWhy ? `${trade} · ${s.bonusWhy}` : trade;
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
 * How the trade-in was reached, in the server's words (Offer.swap.tradeInDetail): its one line
 * ("PriceIQ Good ₹51,399 − 2% − 2 defects") and, closed, each step with its % and rupees — the
 * same as the store app's "Show details". Nothing when the quote is a single figure.
 */
function TradeInHow({ d }: { d: NonNullable<Offer["swap"]["tradeInDetail"]> }) {
  if (!d.line && !d.lines.length && !d.note) return null;
  return (
    <>
      {d.line ? <Small>{d.line}</Small> : null}
      {d.lines.length || d.note ? (
        <details className="group">
          <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-block text-[13.5px] font-semibold text-fix hover:underline">
            Show details <span aria-hidden className="inline-block group-open:rotate-90 transition-transform">›</span>
          </summary>
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

const FIGURE = "num text-[26px] sm:text-[36px] font-[780] leading-tight tracking-tight [overflow-wrap:anywhere]";

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

  // An expired quote is re-quoted once, quietly, the moment the answer shows it (the store app's
  // answer screen does the same): ONCE per page open, whatever comes back — a partner whose fresh
  // quote is already out of date must not be asked again and again with the IMEI. The tile's
  // "Re-quote" is the way to ask again. Never a quote typed in from the partner's app (autoRequoteKey).
  const autoKey = autoRequoteKey(view);
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

  // Refurb quote — the reason is said once: the tile's why, else the refusal if it differs.
  const r = o.repair;
  const repairWhy = r.amount === null && !r.nothingToRepair ? r.why : null;
  const repairRefusal = o.actions.repair && o.actions.repair !== repairWhy && !(r.nothingToRepair && o.actions.repair === r.why) ? o.actions.repair : null;
  // Trade-in + bonus
  const w = o.swap;
  const bonus = bonusLine(o);
  const phoneLine = newPhoneLine(o);
  const vs = vsRepairLine(w.vsRepair);
  const swapWhy = w.total === null ? w.why : null;
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

        {/* The phone's grade: under the answer, never inside its price tiles (docs/GRADING.md). */}
        {view.grading ? (
          <div className="rounded-[12px] border border-line px-4 py-3">
            <GradeRow view={view} />
          </div>
        ) : null}

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
            ) : c.kind === "partner_quote_entry" ? (
              <PartnerQuoteEntry ops={ops} why={c.why} size={c.size} />
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

        {/* The two numbers, side by side even on a phone */}
        <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
          <Tile label="Refurb quote" recommended={badge === "repair"}>
            {r.nothingToRepair && r.amount === null ? (
              <div className="text-[20px] sm:text-[26px] font-[760] leading-tight">Nothing to repair</div>
            ) : (
              <div className={`${FIGURE} ${r.amount === null ? "text-muted" : ""}`}>{r.amount !== null ? inr(r.amount) : "—"}</div>
            )}
            {r.amount !== null && r.detail ? <Small>{r.detail}</Small> : null}
            {repairWhy ? <Small>{repairWhy}</Small> : null}
            {editable && repairRefusal ? <Small tone="ink">{repairRefusal}</Small> : null}
            {r.amount !== null && !r.nothingToRepair ? <TileLink onClick={() => onStep("step-repair")}>Change</TileLink> : null}
            {!r.nothingToRepair ? (
              <p className="text-[13.5px] text-ink-2">
                Cover: {COVER_SHORT[r.coverage]} · <TileLink onClick={() => onStep("step-phone")}>change</TileLink>
              </p>
            ) : null}
          </Tile>

          <Tile label="Trade-in + bonus" recommended={badge === "swap"}>
            <div className={`${FIGURE} ${w.total === null ? "text-muted" : ""}`}>{w.total !== null ? inr(w.total) : "—"}</div>
            {swapWhy ? <Small>{swapWhy}</Small> : null}
            {bonus ? <Small>{bonus}</Small> : null}
            {w.tradeInDetail ? <TradeInHow d={w.tradeInDetail} /> : null}
            {w.tradeInNote ? <Small tone="warn">{w.tradeInNote}</Small> : null}
            {/* The quiet re-quote above is the usual way out; this is for when it failed or the advisor wants it now. */}
            {editable && requotable(view) ? (
              <>
                <TileLink onClick={requote} disabled={requoting}>
                  {requoting ? "Re-quoting…" : "Re-quote"}
                </TileLink>
                {requoteErr ? <Small tone="warn">{requoteErr}</Small> : null}
              </>
            ) : null}
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
      </div>

      {/* What the customer chose — at the counter only; a closed or read-only case has nothing to choose */}
      {editable ? (
      <div className="border-t border-line px-5 py-3 space-y-2 rounded-b-[14px] no-print">
        {confirm === "repair" ? (
          <div className="rounded-[12px] border border-line p-3 space-y-2">
            <div className="text-[14px] font-semibold">Closes the case. Book the repair as usual.</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-fix btn-sm" disabled={acting} onClick={() => run("choose_repair")}>
                {acting ? "Closing…" : "Customer will repair"}
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
                disabled={o.actions.repair !== null || busy}
                title={o.actions.repair ?? undefined}
                onClick={() => {
                  setErr(null);
                  setConfirm("repair");
                }}
              >
                Customer will repair
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
