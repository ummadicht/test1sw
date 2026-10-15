"use client";

import { useState } from "react";
import { Money, Pct, Banner, ErrorText } from "@/components/ui";
import { QuoteSource } from "./StepTradeIn";
import type { CaseOps } from "./ops";

const FAVOURS: Record<"keep" | "let_go" | "level", string> = {
  keep: "At resale value, the phone is worth more to the customer kept (repaired) than let go as it is.",
  let_go: "At resale value, the phone is worth more to the customer let go as it is than repaired.",
  level: "At resale value, the phone is worth about the same to the customer kept or let go.",
};

function Row({ label, children, strong, hint }: { label: React.ReactNode; children: React.ReactNode; strong?: boolean; hint?: React.ReactNode }) {
  return (
    <div className={strong ? "border-t border-line pt-2" : ""}>
      <dt className={`text-[12.5px] leading-tight ${strong ? "font-bold text-ink" : "text-ink-2"}`}>
        {label}
        {hint ? <span className="text-muted font-normal"> · {hint}</span> : null}
      </dt>
      <dd className={strong ? "text-[26px] font-[780] leading-tight tracking-tight" : "text-[16px] font-semibold leading-snug"}>{children}</dd>
    </div>
  );
}

/**
 * The comparison the customer sees across the counter: REPAIR vs UPGRADE in
 * rupees, the reasons each way, and the honest money line — even when it earns
 * the centre nothing. The bonus appears in the upgrade column, never as a reason.
 */
export function DecisionPanel({ ops, onUpgrade, isCounter }: { ops: CaseOps; onUpgrade: () => void; isCounter: boolean }) {
  const { view, editable, busy, act } = ops;
  const d = view.decision;
  const [confirm, setConfirm] = useState<null | "repair" | "walk">(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const rec = d?.recommendation ?? "cannot_say";
  const tone = rec === "repair" ? "bg-fix-bg text-fix border-[color:color-mix(in_srgb,var(--fix)_25%,transparent)]" : rec === "upgrade" ? "bg-up-bg text-[color:var(--up-strong)] border-[color:color-mix(in_srgb,var(--up)_25%,transparent)]" : "bg-surface-2 text-ink border-line";
  const partner = view.quote?.partner ?? view.partner?.partnerName ?? "partner";
  const sample = view.quote?.source.kind === "sample" || view.repairedQuote?.source.kind === "sample";

  // Repair column: the decision's figures, else the service's own numbers if it has them.
  const repairPays = d?.repair?.pays ?? (view.repair?.status === "quoted" ? view.repair.customerPays : null);
  const covered = !!d?.repair?.covered;
  const keepsValue = d?.repair?.keepsValue ?? (view.repairedQuote?.status === "priced" ? view.repairedQuote.amount : null);
  const up = d?.upgrade ?? null;
  const bonusBp = view.bonus ? (view.bonus.override?.bp ?? view.bonus.bp) : null;
  const tradeIn = up?.tradeIn ?? (view.quote?.status === "priced" ? view.quote.amount : null);

  async function run(action: string, extra?: Record<string, unknown>) {
    setActing(true);
    const e = await act(action, extra);
    setActing(false);
    setErr(e);
    if (!e) setConfirm(null);
  }

  return (
    <section className="card" aria-label="Repair or upgrade">
      <header className={`px-5 py-4 border-b rounded-t-[14px] ${tone}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="section-title !text-current opacity-80">Repair or upgrade?</div>
          {busy ? <span className="text-[12px] font-semibold opacity-80" aria-live="polite">Updating…</span> : null}
        </div>
        <div className="text-[20px] font-[760] leading-snug mt-1">{d?.headline ?? "Not enough to compare yet"}</div>
      </header>

      <div className="px-5 py-4 space-y-4">
        {sample ? (
          <Banner tone="sample">
            Trade-in figures here are <strong>SAMPLE</strong> values, not {`${partner} prices. Show the comparison, but don't promise these amounts.`}
          </Banner>
        ) : null}

        <div className="grid grid-cols-2 gap-2.5">
          {/* REPAIR */}
          <div className={`rounded-[12px] border px-3 py-3 min-w-0 ${rec === "repair" ? "border-[color:var(--fix)] ring-1 ring-[color:var(--fix)]" : "border-line"}`}>
            <div className="text-[12px] font-bold uppercase tracking-wider text-fix mb-2">Repair</div>
            <dl className="space-y-2">
              {covered ? (
                <Row label="Customer pays" strong>
                  <span className="text-fix">Covered — ₹0</span>
                </Row>
              ) : (
                <Row label="Customer pays" strong>
                  <Money value={repairPays} className="text-fix" />
                </Row>
              )}
              <Row label="Phone worth after repair" hint="resale value">
                <Money value={keepsValue} />
              </Row>
              <Row label="Security updates until">
                <span className="num">{view.device?.supportEndYear ?? "—"}</span>
              </Row>
              {d?.metrics.costPerYearRepair != null ? (
                <Row label="Cost per year of use">
                  <Money value={d.metrics.costPerYearRepair} />
                </Row>
              ) : null}
            </dl>
            {repairPays === null && !covered ? (
              <p className="hint">{view.faults.length || view.manualRepair ? "No repair price yet — see step 4." : "Nothing to repair."}</p>
            ) : null}
          </div>

          {/* UPGRADE */}
          <div className={`rounded-[12px] border px-3 py-3 min-w-0 ${rec === "upgrade" ? "border-[color:var(--up)] ring-1 ring-[color:var(--up)]" : "border-line"}`}>
            <div className="text-[12px] font-bold uppercase tracking-wider text-up mb-2">Upgrade</div>
            {view.upgrade ? (
              <dl className="space-y-2">
                <Row label={<span className="font-semibold text-ink">{view.upgrade.model} {view.upgrade.variant}</span>}>
                  <Money value={view.upgrade.price} />
                </Row>
                <Row
                  label={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      − Trade-in ({partner}) <QuoteSource quote={view.quote} />
                    </span>
                  }
                >
                  <Money value={tradeIn} />
                </Row>
                <Row label={<>− Upgrade bonus{bonusBp !== null ? <> (<Pct bp={bonusBp} />)</> : ""}</>}>
                  <Money value={up ? up.bonus : view.bonus ? (view.bonus.override?.amount ?? view.bonus.amount) : null} />
                </Row>
                <Row label="= Customer pays" strong>
                  <Money value={up?.pays ?? null} className="text-up" />
                </Row>
                {up?.extraVsRepair != null ? (
                  <div className="text-[13px] font-semibold text-ink-2 -mt-1">
                    {up.extraVsRepair > 0 ? (
                      <>
                        <Money value={up.extraVsRepair} /> more than repairing
                      </>
                    ) : up.extraVsRepair < 0 ? (
                      <>
                        <Money value={-up.extraVsRepair} /> less than repairing
                      </>
                    ) : (
                      "Same as repairing"
                    )}
                  </div>
                ) : null}
                <Row label="Security updates until">
                  <span className="num">{view.upgrade.supportEndYear ?? "—"}</span>
                </Row>
                {d?.metrics.costPerYearUpgrade != null ? (
                  <Row label="Cost per year of use">
                    <Money value={d.metrics.costPerYearUpgrade} />
                  </Row>
                ) : null}
              </dl>
            ) : (
              <p className="text-[13.5px] text-muted">Choose the new phone in step 6 to see what the customer would pay.</p>
            )}
            {view.upgrade && !up ? <p className="hint">No trade-in value yet, so no upgrade price — see step 5.</p> : null}
          </div>
        </div>

        {d && d.signals.length ? (
          <div>
            <div className="section-title mb-1.5">Why</div>
            <ul className="space-y-1.5">
              {d.signals.map((s) => (
                <li key={s.code} className={`text-[14px] leading-snug ${s.strength === "strong" ? "font-semibold" : "text-ink-2"}`}>
                  <span className={`mr-1.5 whitespace-nowrap ${s.points === "repair" ? "text-fix" : "text-up"}`}>{s.points === "repair" ? "→ Repair" : "→ Upgrade"}</span>
                  {s.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {d?.favoursCustomer ? <p className="text-[14px] font-semibold">{FAVOURS[d.favoursCustomer]}</p> : null}

        {d && d.missing.length ? (
          <div>
            <div className="section-title mb-1">Still needed</div>
            <ul className="list-disc pl-5 text-[13.5px] text-ink-2 space-y-0.5">
              {d.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {d && d.caveats.length ? (
          <ul className="text-[12.5px] text-muted space-y-1">
            {d.caveats.map((c) => (
              <li key={c}>• {c}</li>
            ))}
          </ul>
        ) : null}

      </div>
      {isCounter && editable ? (
        <div className="sticky bottom-0 z-10 bg-surface border-t border-line px-5 py-3 space-y-2 rounded-b-[14px] no-print">
          {confirm === "repair" ? (
            <div className="rounded-[12px] border border-line p-3 space-y-2">
              <div className="text-[14px] font-semibold">Close this case as a repair? The customer keeps the phone.</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-fix btn-sm" disabled={acting} onClick={() => run("choose_repair")}>
                  Yes — customer will repair
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                  Back
                </button>
              </div>
            </div>
          ) : confirm === "walk" ? (
            <div className="rounded-[12px] border border-line p-3 space-y-2">
              <label className="block">
                <span className="label">Why did they leave? (optional)</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wants to think about it" maxLength={200} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-sm btn-primary" disabled={acting} onClick={() => run("walk_away", { reason: reason.trim() || undefined })}>
                  Close the case
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-fix !whitespace-normal !px-3 leading-tight" disabled={view.status !== "quoted" || busy} onClick={() => setConfirm("repair")}>
                  Customer will repair
                </button>
                <button
                  type="button"
                  className="btn btn-up !whitespace-normal !px-3 leading-tight"
                  disabled={view.status !== "quoted" || !view.upgrade}
                  title={!view.upgrade ? "Choose the new phone first (step 6)" : undefined}
                  onClick={onUpgrade}
                >
                  Customer will upgrade
                </button>
              </div>
              <button type="button" className="btn btn-ghost btn-sm w-full" onClick={() => setConfirm("walk")}>
                Customer walked away
              </button>
            </>
          )}
          <ErrorText error={err} />
        </div>
      ) : null}
    </section>
  );
}
