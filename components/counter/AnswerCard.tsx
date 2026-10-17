"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorText } from "@/components/ui";
import { inr, fmtBp } from "@/lib/domain/money";
import type { Offer } from "@/lib/domain/offer";
import type { CaseOps } from "./ops";
import { askControl, autoRequoteKey, requotable, swapRefusal } from "./answerAsks";
import { CashifyQuoteEntry, IdentityOverride } from "./AnswerAskForms";

/**
 * THE ANSWER, first, once the test is on the case (owner, 2026-10-17: "Why asking
 * questions when we have all tested data ... just refurb quote vs bonus + trade in price"):
 *
 *     Refurb quote          vs     Trade-in + bonus
 *     what fixing it costs         the partner's as-is price + the upgrade bonus
 *
 * The same numbers and the same words as the SwapUp Store answer screen: the server
 * builds every figure and every reason (CaseView.offer, lib/domain/offer.ts) and this
 * card only lays them out. Whatever the test couldn't fill is one tap here (storage
 * chips with each size's trade-in) or a jump to the step that fills it — never a
 * guessed size. Where no step can fill it (a lapsed Cashify quote, a size not on file,
 * the camera's identity check) it is answered here (answerAsks.ts says which). An
 * expired quote is re-quoted once on open, as the store app does, so "re-quoting" is
 * true. The verdict is decide()'s headline; the bonus is shown, never a reason.
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
  if (n > 0) return `${inr(n)} more than repairing today`;
  if (n < 0) return `${inr(-n)} less than repairing`;
  return "Same as repairing";
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

const FIGURE = "num text-[26px] sm:text-[36px] font-[780] leading-tight tracking-tight [overflow-wrap:anywhere]";

export function AnswerCard({
  ops,
  isManager,
  onStep,
  onSwap,
  onWhy,
}: {
  ops: CaseOps;
  /** The store manager: the only one who may accept a phone the camera says isn't the one on the case. */
  isManager: boolean;
  /** Open the folded steps and scroll to one of them ("step-phone", …). */
  onStep: (id: string) => void;
  /** "Swap up": show the lock form and go to it. */
  onSwap: () => void;
  /** Below lg, where the comparison panel sits inside the folded steps. */
  onWhy: () => void;
}) {
  const { view, busy, save, act } = ops;
  const [confirm, setConfirm] = useState<null | "repair" | "walk">(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [requoting, setRequoting] = useState(false);
  const [requoteErr, setRequoteErr] = useState<string | null>(null);

  // An expired quote is re-quoted once, quietly, the moment the answer shows it (the store app's
  // answer screen does the same): ONCE per page open, whatever comes back — a partner whose fresh
  // quote is already out of date must not be asked again and again with the IMEI. The tile's
  // "Re-quote" is the way to ask again. Never a Cashify-app quote (autoRequoteKey).
  const autoKey = autoRequoteKey(view);
  const autoTried = useRef(false);
  useEffect(() => {
    if (!autoKey || autoTried.current) return;
    autoTried.current = true;
    setRequoting(true);
    void act("reprice").then((e) => {
      setRequoting(false);
      setRequoteErr(e);
    });
  }, [autoKey, act]);

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
          {o.storage.note ? <p className="text-[13.5px] text-warn font-semibold leading-snug mt-1.5">{o.storage.note}</p> : null}
          {o.signals.length || o.caveats.length ? (
            <button type="button" className="lg:hidden mt-1.5 text-[13.5px] font-semibold text-fix hover:underline no-print" onClick={onWhy}>
              Why this answer ›
            </button>
          ) : null}
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
                {/* "Sample price — not a real quote." for as long as the sample figures are on screen, before the tap as after it. */}
                {c.note ? <Small tone="warn">{c.note}</Small> : null}
              </>
            ) : c.kind === "cashify" ? (
              <CashifyQuoteEntry ops={ops} why={c.why} size={c.size} />
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
            {repairRefusal ? <Small tone="ink">{repairRefusal}</Small> : null}
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
            {w.tradeInNote ? <Small tone="warn">{w.tradeInNote}</Small> : null}
            {/* The quiet re-quote above is the usual way out; this is for when it failed or the advisor wants it now. */}
            {requotable(view) ? (
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
              <TileLink onClick={() => onStep("step-upgrade")}>Choose the new phone</TileLink>
            )}
            {vs ? <Small>{vs}</Small> : null}
            {swapNo ? <Small tone="ink">{swapNo}</Small> : null}
          </Tile>
        </div>
      </div>

      {/* What the customer chose */}
      <div className="border-t border-line px-5 py-3 space-y-2 rounded-b-[14px] no-print">
        {confirm === "repair" ? (
          <div className="rounded-[12px] border border-line p-3 space-y-2">
            <div className="text-[14px] font-semibold">This closes the case. Book the repair in the service centre&apos;s job system.</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-fix btn-sm" disabled={acting} onClick={() => run("choose_repair")}>
                {acting ? "Closing the case…" : "Customer will repair"}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={acting} onClick={() => setConfirm(null)}>
                Not yet
              </button>
            </div>
          </div>
        ) : confirm === "walk" ? (
          <div className="rounded-[12px] border border-line p-3 space-y-2">
            <div className="text-[14px] font-semibold">This closes the case. Why, if the customer said:</div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Why they left (optional)">
              {WALK_AWAY_REASONS.map((x) => (
                <button key={x} type="button" className="chip" aria-pressed={reason === x} onClick={() => setReason((cur) => (cur === x ? "" : x))}>
                  {x}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-primary" disabled={acting} onClick={() => run("walk_away", reason ? { reason } : {})}>
                {acting ? "Closing the case…" : "Customer walked away"}
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
    </section>
  );
}
