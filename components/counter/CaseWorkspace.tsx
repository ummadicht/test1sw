"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { api } from "@/lib/client/api";
import { Banner, StatusPill } from "@/components/ui";
import { CASE_STATUS_LABEL } from "@/lib/domain/lifecycle";
import type { CaseView, CasePatch } from "@/lib/server/cases";
import type { Role } from "@/lib/server/auth";
import { StepPhone } from "./StepPhone";
import { StepFaults } from "./StepFaults";
import { StepCondition } from "./StepCondition";
import { StepRepair } from "./StepRepair";
import { StepTradeIn } from "./StepTradeIn";
import { StepUpgrade } from "./StepUpgrade";
import { DecisionPanel } from "./DecisionPanel";
import { LockForm } from "./LockForm";
import { LockedSummary } from "./LockedSummary";
import { AnswerCard } from "./AnswerCard";
import { fmtWhen } from "./shared";
import type { CaseOps, ModelOption, CampaignBand, PickupInfo } from "./ops";

const COUNTER: Role[] = ["advisor", "store_manager"];
const AT_COUNTER = ["draft", "quoted"];

/** The folded steps' one-line summary: "Galaxy S23 Ultra · storage ? · 1 fault · cover none". */
const COVER_WORD: Record<CaseView["coverage"], string> = { none: "none", warranty: "warranty", care_plus: "Care+" };

function scrollToLock(nameRef: RefObject<HTMLInputElement | null>) {
  const el = document.getElementById("step-lock");
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 450);
}

/**
 * The counter workspace for one case. Every change is saved at once and the
 * case comes back re-priced; saves run one at a time, in order, so the server
 * always ends on the advisor's last tap. Only the latest answer is painted.
 *
 * ANSWER FIRST — once a phone test is on the case (or the store app handed off
 * with ?view=answer): the answer (refurb quote vs trade-in + bonus) leads, the
 * six steps fold into one line with "Edit", and the lock form waits for "Swap up".
 * The test already answered the steps; asking them again is what the owner
 * objected to. Without a test the page is the step-by-step desk, unchanged.
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
  const details = useRef<HTMLDetailsElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const lockPending = useRef(false);

  const isCounter = COUNTER.includes(role);
  const isManager = role === "store_manager";
  const editable = isCounter && AT_COUNTER.includes(view.status);
  const answerFirstMode = editable && (view.camera !== null || answerFirst);
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

  const save = useCallback(
    (patch: CasePatch, optimistic?: Partial<CaseView>) => {
      if (optimistic) setView((v) => ({ ...v, ...optimistic }));
      return run(() => api<CaseView>(`/api/cases/${id}`, { method: "PATCH", body: patch }));
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

  function goToLock() {
    scrollToLock(lockName);
  }

  /** "Swap up": in answer-first mode the lock form is mounted on demand — mount it, then go to it once it is there. */
  const swapUp = useCallback(() => {
    if (document.getElementById("step-lock")) return scrollToLock(lockName);
    lockPending.current = true;
    setShowLock(true);
  }, []);
  useEffect(() => {
    if (!showLock || !lockPending.current) return;
    lockPending.current = false;
    scrollToLock(lockName);
  }, [showLock]);

  /** Unfold the steps and bring one into view: an ask's button, a tile's "Change", or a #step-… hand-off link. */
  const openStep = useCallback((target: string) => {
    const d = details.current;
    if (d && !d.open) d.open = true; // the toggle event syncs detailsOpen
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  // The hand-off may carry an anchor (/cases/<id>?view=answer#step-phone). Folded steps can't be
  // scrolled to by the browser, and the lock form isn't mounted yet — follow the anchor ourselves.
  useEffect(() => {
    if (!answerFirstMode) return;
    function follow() {
      const target = decodeURIComponent(window.location.hash.slice(1));
      if (target === "step-lock") swapUp();
      else if (target.startsWith("step-") || target === "why-answer") openStep(target);
    }
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [answerFirstMode, swapUp, openStep]);

  const back = isCounter ? { href: "/desk", label: "Counter" } : { href: "/cases", label: "Cases" };

  const steps = (): ReactNode => (
    <>
      <StepPhone ops={ops} brands={brands} initialModel={initialModel} />
      <StepFaults ops={ops} />
      <StepCondition ops={ops} />
      <StepRepair ops={ops} />
      <StepTradeIn ops={ops} showBuySell={role !== "partner"} />
      <StepUpgrade ops={ops} isManager={isManager} bands={bands} />
    </>
  );

  return (
    <div>
      {/* Case header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <Link href={back.href} className="text-[13px] no-underline hover:underline no-print">
            <span className="text-muted">← {back.label}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <h1 className="text-[24px] font-[760] tracking-tight leading-tight">{showCustomer && view.customer?.name ? view.customer.name : "Case"}</h1>
            <StatusPill status={view.status} label={CASE_STATUS_LABEL[view.status]} />
            {view.demo ? <span className="pill pill-sample">Example case</span> : null}
          </div>
          <div className="text-[13px] text-muted mt-0.5">
            <span className="num">{view.ref}</span> · {view.storeName} · opened {fmtWhen(view.createdAt)}
            {view.advisorName ? ` by ${view.advisorName}` : ""}
          </div>
        </div>
      </div>

      {view.status === "repair_chosen" ? (
        <div className="mb-5">
          <Banner tone="info">
            Closed {fmtWhen(view.closedAt)} — the customer chose to repair and keep the phone. Book the repair in the service centre&apos;s job system as
            usual.
          </Banner>
        </div>
      ) : null}
      {view.status === "walked_away" ? (
        <div className="mb-5">
          <Banner tone="info">
            Closed {fmtWhen(view.closedAt)} — the customer left without repairing or upgrading.
            {view.closedReason ? <> Reason given: &ldquo;{view.closedReason}&rdquo;</> : null}
          </Banner>
        </div>
      ) : null}
      {!isCounter && AT_COUNTER.includes(view.status) ? (
        <div className="mb-5">
          <Banner>This case is still at the counter. You are seeing it read-only.</Banner>
        </div>
      ) : null}

      {answerFirstMode ? (
        <div className="mb-5">
          <AnswerCard ops={ops} isManager={isManager} onStep={openStep} onSwap={swapUp} onWhy={() => openStep("why-answer")} />
        </div>
      ) : null}

      <div className={`grid gap-5 items-start ${role === "partner" ? "max-w-[880px]" : "lg:grid-cols-[minmax(0,1fr)_400px]"}`}>
        {/* Steps (or, once traded in, the summary) */}
        <div className="space-y-5 min-w-0 lg:col-start-1 lg:row-start-1">
          {lockedOrLater ? (
            <LockedSummary ops={ops} isManager={isManager} isCounter={isCounter} showCustomer={showCustomer} pickup={pickup} />
          ) : answerFirstMode ? (
            // suppressHydrationWarning: a #step-… link makes the browser open <details> itself before React hydrates.
            <details id="case-details" ref={details} onToggle={(e) => setDetailsOpen(e.currentTarget.open)} suppressHydrationWarning>
              <summary className="card list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center gap-3 px-5 py-3.5 no-print">
                <span className="min-w-0 flex-1">
                  <span className="section-title block">Case details</span>
                  <span className="block text-[15px] font-semibold leading-snug mt-0.5">{foldedSummary(view)}</span>
                </span>
                <span className="btn btn-sm shrink-0" aria-hidden>
                  {detailsOpen ? "Close" : "Edit"}
                </span>
              </summary>
              <div className="space-y-5 mt-5">
                {steps()}
                {/* Below lg the comparison panel lives here; on a wide screen it stays beside the answer. */}
                <div id="why-answer" className="lg:hidden scroll-mt-28">
                  <div className="section-title mb-2 px-1">Why this answer</div>
                  <DecisionPanel ops={ops} onUpgrade={swapUp} isCounter={false} />
                </div>
              </div>
            </details>
          ) : (
            steps()
          )}
        </div>

        {/* Decision — sticky beside the steps on a wide screen, after them on a phone.
            The buyback partner sees the phone, the declared condition and its verdict — not the customer's comparison.
            Answer-first: the answer card carries the buttons, so the panel is only the why (isCounter={false} hides its own). */}
        {role === "partner" ? null : (
        <aside
          className={`min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[100px] lg:max-h-[calc(100vh-116px)] lg:overflow-y-auto rounded-[14px] ${answerFirstMode ? "hidden lg:block" : ""}`}
        >
          {lockedOrLater ? <div className="section-title mb-2 px-1">What the customer was shown</div> : null}
          {answerFirstMode ? <div className="section-title mb-2 px-1">Why this answer</div> : null}
          <DecisionPanel ops={ops} onUpgrade={answerFirstMode ? swapUp : goToLock} isCounter={isCounter && !answerFirstMode} />
        </aside>
        )}

        {editable && (!answerFirstMode || showLock) ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <LockForm ops={ops} ref={lockName} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** "Galaxy S23 Ultra · storage ? · 1 fault · cover none" — what the folded steps hold. */
function foldedSummary(v: CaseView): string {
  const n = v.faults.length;
  return [v.device ? v.device.model : "No phone yet", v.device?.variant ?? "storage ?", `${n} ${n === 1 ? "fault" : "faults"}`, `cover ${COVER_WORD[v.coverage]}`].join(" · ");
}
