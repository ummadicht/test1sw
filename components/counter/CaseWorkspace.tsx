"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
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
import { fmtWhen } from "./shared";
import type { CaseOps, ModelOption, CampaignBand, PickupInfo } from "./ops";

const COUNTER: Role[] = ["advisor", "store_manager"];
const AT_COUNTER = ["draft", "quoted"];

/**
 * The counter workspace for one case. Every change is saved at once and the
 * case comes back re-priced; saves run one at a time, in order, so the server
 * always ends on the advisor's last tap. Only the latest answer is painted.
 */
export function CaseWorkspace({
  initial,
  role,
  brands,
  initialModel,
  bands,
  pickup,
}: {
  initial: CaseView;
  role: Role;
  brands: string[];
  initialModel: ModelOption | null;
  bands: Record<string, CampaignBand>;
  pickup: PickupInfo | null;
}) {
  const [view, setView] = useState<CaseView>(initial);
  const [pending, setPending] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ticket = useRef(0);
  const lockName = useRef<HTMLInputElement>(null);

  const isCounter = COUNTER.includes(role);
  const isManager = role === "store_manager";
  const editable = isCounter && AT_COUNTER.includes(view.status);
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
    const el = document.getElementById("step-lock");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => lockName.current?.focus({ preventScroll: true }), 450);
  }

  const back = isCounter ? { href: "/desk", label: "Counter" } : { href: "/cases", label: "Cases" };

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

      <div className={`grid gap-5 items-start ${role === "partner" ? "max-w-[880px]" : "lg:grid-cols-[minmax(0,1fr)_400px]"}`}>
        {/* Steps (or, once traded in, the summary) */}
        <div className="space-y-5 min-w-0 lg:col-start-1 lg:row-start-1">
          {lockedOrLater ? (
            <LockedSummary ops={ops} isManager={isManager} isCounter={isCounter} showCustomer={showCustomer} pickup={pickup} />
          ) : (
            <>
              <StepPhone ops={ops} brands={brands} initialModel={initialModel} />
              <StepFaults ops={ops} />
              <StepCondition ops={ops} />
              <StepRepair ops={ops} />
              <StepTradeIn ops={ops} showBuySell={role !== "partner"} />
              <StepUpgrade ops={ops} isManager={isManager} bands={bands} />
            </>
          )}
        </div>

        {/* Decision — sticky beside the steps on a wide screen, after them on a phone.
            The buyback partner sees the phone, the declared condition and its verdict — not the customer's comparison. */}
        {role === "partner" ? null : (
        <aside className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[100px] lg:max-h-[calc(100vh-116px)] lg:overflow-y-auto rounded-[14px]">
          {lockedOrLater ? <div className="section-title mb-2 px-1">What the customer was shown</div> : null}
          <DecisionPanel ops={ops} onUpgrade={goToLock} isCounter={isCounter} />
        </aside>
        )}

        {editable ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <LockForm ops={ops} ref={lockName} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
