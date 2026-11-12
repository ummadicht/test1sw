"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Field, StatusPill } from "@/components/ui";
import { CASE_STATUS_LABEL } from "@/lib/domain/lifecycle";
import type { CaseView, CasePatch } from "@/lib/server/cases";
import type { Role } from "@/lib/server/auth";
import { StepPhone } from "./StepPhone";
import { StepFaults } from "./StepFaults";
import { StepRepair } from "./StepRepair";
import { StepTradeIn } from "./StepTradeIn";
import { LockForm } from "./LockForm";
import { LockedSummary } from "./LockedSummary";
import { AnswerCard } from "./AnswerCard";
import { CheckByEye } from "./CheckByEye";
import { PhonecheckPanel } from "./PhonecheckPanel";
import { RefurbDecision } from "./RefurbDecision";
import { RazorpayPaymentPanel } from "./RazorpayPaymentPanel";
import { StepHeader, StepDock } from "./StepNav";
import { STEP_ANCHOR, canShow, landingStep, stepDone, stepFromAnchor, stepOrder, testedCase, type StepId } from "./caseSteps";
import { fmtWhen } from "./shared";
import { CAMERA_REASON_MIN, cameraReasonOk, heldForReason, keepsHeld, withCameraReason } from "./answerAsks";
import type { CaseOps, ModelOption, CampaignBand, PickupInfo } from "./ops";

type Held = { patch: CasePatch; why: string };

/**
 * The camera confirmed the phone worse than the advisor's change says ("Camera confirmed "Cracked
 * screen", photo 2 — removing it needs a reason."): the change waits here for ONE reason, kept with
 * their name, and goes again with it (cases.ts updateCase records it and covers it from then on).
 */
function CameraReason({ held, onSave }: { held: Held; onSave: (patch: CasePatch) => Promise<string | null> }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ok = cameraReasonOk(reason);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setSaving(true);
    setErr(await onSave(withCameraReason(held.patch, reason)));
    setSaving(false);
  }

  return (
    <form onSubmit={send} className="card px-4 py-3 mt-3 space-y-2">
      <p className="text-[14px] text-ink leading-snug">{held.why}</p>
      <Field label="Why it's better" hint={`${CAMERA_REASON_MIN}+ characters, kept with your name.`}>
        <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
      </Field>
      <button className="btn btn-sm btn-primary" disabled={!ok || saving}>
        {saving ? "Saving…" : "Save with reason"}
      </button>
      <ErrorText error={err} />
    </form>
  );
}

const COUNTER: Role[] = ["advisor", "store_manager"];
const AT_COUNTER = ["draft", "quoted"];

/**
 * The counter workspace for one case — STEP BY STEP (caseSteps.ts): one step on the screen at a
 * time, in the store app's order —
 *
 *     Phone → What's wrong → The answer   (→ Take the trade-in)
 *
 * with "Step 2 of 3 · What's wrong" on top (tap it for the list of steps) and Back / Next docked
 * at the bottom. Each step asks one question and says one line; the rest is behind its "Show
 * details", closed. The answer is the answer card (refurb quote vs trade-in + bonus, the SwapUp
 * grade, Repair / Swap up / Walked away) with "Refurb decision · staff only" closed under it; its
 * asks and "Change" links open the Repair quote and the Trade-in as pages of their own ("The
 * answer › Repair quote", Back to the answer); "Swap up" opens the last step. One answer on the
 * page: no comparison panel beside it.
 *
 * Where it opens (landingStep): a link to a step (#step-repair, the store app's #step-phone or
 * #answer) opens that step; a tested case (SwapUp Check or Phonecheck), the store app's ?view=answer, and a case this viewer
 * can't change open on the answer; otherwise the first step not answered yet. A save never moves
 * the page — it stays on the step. Once traded in, the summary alone.
 *
 * Every change is saved at once and the case comes back re-priced; saves run one at a time, in
 * order, so the server always ends on the advisor's last tap. Only the latest answer is painted.
 * The price itself is never typed in: what's wrong with the phone is what changes it. A fault or
 * condition change the store camera contradicts is kept for one reason (CameraReason), not lost.
 */
export function CaseWorkspace({
  initial,
  role,
  brands,
  initialModel,
  bands,
  pickup,
  answerFirst = false,
}: {
  initial: CaseView;
  role: Role;
  brands: string[];
  initialModel: ModelOption | null;
  bands: Record<string, CampaignBand>;
  pickup: PickupInfo | null;
  /** ?view=answer — the store app's hand-off asks for the answer first even before a test. */
  answerFirst?: boolean;
}) {
  const [view, setView] = useState<CaseView>(initial);
  const [pending, setPending] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ticket = useRef(0);
  const lockName = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);

  const isCounter = COUNTER.includes(role);
  const isManager = role === "store_manager";
  const editableOf = (v: CaseView) => isCounter && AT_COUNTER.includes(v.status);
  const editable = editableOf(view);
  const id = initial.id;

  const run = useCallback(
    (fn: () => Promise<CaseView>): Promise<string | null> => {
      const mine = ++ticket.current;
      setPending((p) => p + 1);
      const p = queue.current.then(async () => {
        try {
          const v = await fn();
          if (mine === ticket.current) setView(v);
          return null;
        } catch (e) {
          // Re-sync with what the server actually holds, so the screen never shows an unsaved state.
          try {
            const v = await api<CaseView>(`/api/cases/${id}`);
            if (mine === ticket.current) setView(v);
          } catch {
            /* keep what we have; the error below says what failed */
          }
          return (e as Error).message;
        } finally {
          setPending((n) => n - 1);
        }
      });
      queue.current = p.catch(() => null);
      return p;
    },
    [id]
  );

  // The last change the camera's 409 held back, waiting for its reason; the next save replaces it
  // (not its own failed resend).
  const [held, setHeld] = useState<Held | null>(null);

  const save = useCallback(
    async (patch: CasePatch, optimistic?: Partial<CaseView>) => {
      if (optimistic) setView((v) => ({ ...v, ...optimistic }));
      const e = await run(() => api<CaseView>(`/api/cases/${id}`, { method: "PATCH", body: patch }));
      // A failed "Save with reason" keeps its field open, and the field says why.
      if (keepsHeld(patch, e)) return e;
      const h = heldForReason(patch, e);
      setHeld(h);
      // A held change says its sentence once, beside its reason field — not again under the chips.
      return h ? null : e;
    },
    [id, run]
  );

  const act = useCallback(
    (action: string, extra: Record<string, unknown> = {}) => run(() => api<CaseView>(`/api/cases/${id}/action`, { body: { action, ...extra } })),
    [id, run]
  );

  const ops: CaseOps = { view, editable, busy: pending > 0, save, act };
  const lockedOrLater = !AT_COUNTER.includes(view.status) && view.status !== "repair_chosen" && view.status !== "walked_away";
  const showCustomer = role !== "partner";
  const isPartner = role === "partner";
  /**
   * "Refurb decision · staff only", closed, under the answer — whenever the server sends it: a priced
   * trade-in at the counter, or traded in until the partner's pickup (read-only). Never the partner's.
   */
  const refurb = !isPartner && view.refurbEconomics ? <RefurbDecision ops={ops} /> : null;

  /* ─────────── the steps ─────────── */
  const hasAnswer = view.offer !== null;
  const canLock = editable && hasAnswer;
  const [lockOpen, setLockOpen] = useState(false);
  const steps = stepOrder({ answer: hasAnswer, lock: canLock && lockOpen });
  const done = (s: StepId) => stepDone(view, s);
  const [step, setStep] = useState<StepId>(() =>
    landingStep({
      steps: stepOrder({ answer: initial.offer !== null, lock: false }),
      answerFirst,
      tested: testedCase(initial),
      editable: editableOf(initial),
      canLock: false,
      done: (s) => stepDone(initial, s),
    })
  );
  // A step that is no longer there (the trade-in step once the case closed) falls back to the answer.
  // The answer's own pages (Repair quote, Trade-in) show beside it, opened from its asks and links.
  const current: StepId = canShow(steps, step) ? step : hasAnswer ? "answer" : "tradein";

  // The latest of everything the step links need, for the listeners below.
  const latest = useRef({ steps, canLock, hasAnswer, editable, view, answerFirst });
  latest.current = { steps, canLock, hasAnswer, editable, view, answerFirst };
  const focusLock = useRef(false);
  /** Set by Back / Next / the step list: the new step's heading takes the focus (a screen reader hears where it is). */
  const focusStep = useRef(false);

  /** Go to a step: the page shows it alone, from its top; the address says which, so a reload stays on it. */
  const goTo = useCallback((target: StepId) => {
    const l = latest.current;
    let s = target;
    if (s === "lock") {
      if (!l.canLock) s = l.hasAnswer ? "answer" : "tradein";
      else {
        setLockOpen(true);
        focusLock.current = true;
      }
    }
    focusStep.current = true;
    setStep(s);
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${STEP_ANCHOR[s]}`);
    } catch {
      /* the address is a convenience */
    }
    const y = (top.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 88;
    if (window.scrollY > y) window.scrollTo({ top: Math.max(0, y) });
  }, []);

  // A link to a step (/cases/<id>#step-repair, the store app's ?view=answer#step-phone) opens it — on
  // load and whenever the address's anchor changes. The server can't see the anchor, so the page
  // first renders where landingStep puts it without one.
  useEffect(() => {
    function follow() {
      if (!stepFromAnchor(window.location.hash)) return;
      const l = latest.current;
      const s = landingStep({
        steps: l.steps.filter((x) => x !== "lock"),
        anchor: window.location.hash,
        answerFirst: l.answerFirst,
        tested: testedCase(l.view),
        editable: l.editable,
        canLock: l.canLock,
        done: (x) => stepDone(l.view, x),
      });
      if (s === "lock") {
        setLockOpen(true);
        focusLock.current = true;
      }
      setStep(s);
    }
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  // Once a step is on the screen: "Swap up" puts the cursor in the trade-in's first field; any other
  // move puts the focus on the step's heading (not on a field — no keyboard pops up uninvited).
  useEffect(() => {
    if (!focusLock.current && !focusStep.current) return;
    const lock = current === "lock" && focusLock.current;
    focusLock.current = false;
    focusStep.current = false;
    const t = setTimeout(() => {
      if (lock) lockName.current?.focus({ preventScroll: true });
      else document.getElementById(`${STEP_ANCHOR[current]}-title`)?.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(t);
  }, [current]);

  /** The answer card's asks and "Change" links name a step by its anchor ("step-repair"). */
  const onStep = useCallback((anchor: string) => goTo(stepFromAnchor(anchor) ?? "answer"), [goTo]);
  const swapUp = useCallback(() => goTo("lock"), [goTo]);

  const back = isCounter ? { href: "/desk", label: "Counter" } : { href: "/cases", label: "Cases" };

  return (
    <div className="mx-auto max-w-[880px]">
      {/* Case header */}
      <div className="mb-4 min-w-0" ref={top}>
        <Link href={back.href} className="text-[13px] no-underline hover:underline no-print">
          <span className="text-muted">← {back.label}</span>
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-[760] tracking-tight leading-tight">{showCustomer && view.customer?.name ? view.customer.name : "Case"}</h1>
            <StatusPill status={view.status} label={CASE_STATUS_LABEL[view.status]} />
          </div>
          {!isPartner && (lockedOrLater || view.status === "repair_chosen" || view.offer !== null) ? (
            <div className="flex flex-wrap items-center gap-1.5 no-print">
              <Link href={`/cases/${view.id}/receipt`} className="btn btn-sm btn-ghost !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]">
                🖨 Print receipt
              </Link>
              <Link href={`/cases/${view.id}/receipt?email=1`} className="btn btn-sm btn-ghost !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]">
                ✉ Email receipt
              </Link>
            </div>
          ) : null}
        </div>
        <div className="text-[13px] text-muted mt-0.5">
          <span className="num">{view.ref}</span> · {view.storeName} · opened {fmtWhen(view.createdAt)}
          {view.advisorName ? ` by ${view.advisorName}` : ""}
        </div>
      </div>

      {view.status === "repair_chosen" ? (
        <div className="mb-4 space-y-3">
          <Banner tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Closed {fmtWhen(view.closedAt)} — the customer is repairing it.</span>
              <div className="flex items-center gap-2 no-print">
                <Link href={`/cases/${view.id}/receipt?autoprint=1`} className="btn btn-sm !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]">
                  🖨 Print repair receipt
                </Link>
                <Link href={`/cases/${view.id}/receipt?email=1`} className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]">
                  ✉ Email repair receipt
                </Link>
              </div>
            </div>
          </Banner>
          {!isPartner ? (
            <RazorpayPaymentPanel
              caseId={view.id}
              caseRef={view.ref}
              mode="repair"
              repairAmount={
                (view.offer?.repair.amount && view.offer.repair.amount > 0
                  ? view.offer.repair.amount
                  : view.repair?.customerPays && view.repair.customerPays > 0
                    ? view.repair.customerPays
                    : 5000)
              }
              swapAmount={null}
              customerName={view.customer?.name}
              customerPhone={view.customer?.phone}
            />
          ) : null}
        </div>
      ) : null}
      {view.status === "walked_away" ? (
        <div className="mb-4">
          <Banner tone="info">
            Closed {fmtWhen(view.closedAt)} — walked away{view.closedReason ? <>: &ldquo;{view.closedReason}&rdquo;</> : "."}
          </Banner>
        </div>
      ) : null}
      {!isCounter && AT_COUNTER.includes(view.status) ? (
        <div className="mb-4">
          <Banner>At the counter — read-only.</Banner>
        </div>
      ) : null}

      {lockedOrLater ? (
        <div className="space-y-5">
          <LockedSummary ops={ops} isManager={isManager} isCounter={isCounter} isPartner={isPartner} showCustomer={showCustomer} pickup={pickup} />
          {/* Traded in, before the pickup: the decision staff act on ("Repair before pickup"), read-only. */}
          {refurb}
        </div>
      ) : (
        <>
          <StepHeader steps={steps} current={current} done={done} busy={ops.busy} onGo={goTo} />
          {/* The camera couldn't decide: one tap says the phone is fine and opens the answer. */}
          <CheckByEye ops={ops} onDone={() => goTo(hasAnswer ? "answer" : "faults")} onOther={() => goTo("faults")} />
          {/* Every step stays mounted (a half-typed field survives Back and Next); only the current one shows. */}
          <div hidden={current !== "phone"} data-step="phone">
            <StepPhone ops={ops} brands={brands} initialModel={initialModel} />
          </div>
          <div hidden={current !== "faults"} data-step="faults">
            {/* Phonecheck changes the faults, so it sits in this step's details (store staff, at the counter only). */}
            <StepFaults ops={ops} phonecheck={<PhonecheckPanel ops={ops} role={role} run={run} />} />
            {held && editable ? <CameraReason key={held.why} held={held} onSave={save} /> : null}
          </div>
          <div hidden={current !== "repair"} data-step="repair">
            <StepRepair ops={ops} />
          </div>
          <div hidden={current !== "tradein"} data-step="tradein">
            <StepTradeIn ops={ops} isPartner={isPartner} isManager={isManager} bands={bands} />
          </div>
          {hasAnswer ? (
            <div hidden={current !== "answer"} data-step="answer" className="space-y-5">
              <AnswerCard ops={ops} isManager={isManager} onStep={onStep} onSwap={swapUp} />
              {refurb}
            </div>
          ) : null}
          {canLock && lockOpen ? (
            <div hidden={current !== "lock"} data-step="lock">
              <LockForm ops={ops} ref={lockName} />
            </div>
          ) : null}
          <StepDock steps={steps} current={current} onGo={goTo} />
        </>
      )}
    </div>
  );
}
