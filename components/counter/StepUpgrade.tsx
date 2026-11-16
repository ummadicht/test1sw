"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { Money, Pct, ErrorText } from "@/components/ui";
import { pctToBp, fmtBp } from "@/lib/domain/money";
import type { NewDeviceView } from "@/lib/server/catalog";
import { SERIES_ORDER, seriesHeading } from "./shared";
import type { CaseOps, CampaignBand } from "./ops";

const CLAMP_NOTE: Record<string, string> = {
  min: "Raised to the minimum.",
  max: "Capped at the maximum.",
  cap: "Capped at the rupee limit.",
};

/**
 * The upgrade bonus in full — the campaign, how it was worked out, a manager's change — for the
 * trade-in step's "Show details". The step itself says it in one line (bonusLine).
 */
export function BonusDetails({ ops, isManager, bands }: { ops: CaseOps; isManager: boolean; bands: Record<string, CampaignBand> }) {
  const { view } = ops;
  if (!view.upgrade || !view.bonus) return null;
  return <BonusBlock ops={ops} isManager={isManager} band={bands[view.bonus.campaignId] ?? null} />;
}

function BonusBlock({ ops, isManager, band }: { ops: CaseOps; isManager: boolean; band: CampaignBand | null }) {
  const { view, editable, act } = ops;
  const b = view.bonus!;
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bp = b.override?.bp ?? b.bp;
  const amount = b.override?.amount ?? b.amount;
  const canChange = isManager && editable && view.status === "quoted";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = Number(pct);
    if (!pct.trim() || !Number.isFinite(p)) return setErr("Enter a percentage, e.g. 4.5.");
    const newBp = pctToBp(p);
    if (band && (newBp < band.minBp || newBp > band.maxBp)) return setErr(`Must be ${fmtBp(band.minBp)}–${fmtBp(band.maxBp)}.`);
    if (reason.trim().length < 8) return setErr("Say why (8+ characters).");
    setBusy(true);
    const e2 = await act("bonus_override", { bp: newBp, reason: reason.trim() });
    setBusy(false);
    setErr(e2);
    if (!e2) {
      setOpen(false);
      setPct("");
      setReason("");
    }
  }

  async function reset() {
    setBusy(true);
    setErr(await act("bonus_override", { bp: null }));
    setBusy(false);
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-title">Upgrade bonus</div>
          <div className="text-[16px] font-semibold leading-tight mt-0.5">
            <Pct bp={bp} /> = <Money value={amount} />
          </div>
          <div className="text-[13px] text-ink-2">
            of <Money value={b.basisAmount} /> · {b.campaignName} · funded by {b.fundedBy}
          </div>
        </div>
        {canChange ? (
          <div className="flex gap-2">
            {b.override ? (
              <button type="button" className="btn btn-sm" onClick={reset} disabled={busy}>
                Reset
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Change bonus
            </button>
          </div>
        ) : null}
      </div>

      {b.override ? (
        <p className="text-[13px] mt-2">
          Changed by {b.override.by} from <Pct bp={b.bp} /> (<Money value={b.amount} />): &ldquo;{b.override.reason}&rdquo;
        </p>
      ) : null}
      {b.clampedBy && !b.override ? <p className="text-[13px] mt-2 text-ink-2">{CLAMP_NOTE[b.clampedBy]}</p> : null}

      <ul className="mt-2 space-y-1 text-[13.5px]">
        {b.steps.map((s) => (
          <li key={s.label} className={`flex gap-2 ${s.applied ? "" : "text-muted"}`}>
            <span aria-hidden className="w-4 shrink-0 text-center">{s.applied ? "✓" : "–"}</span>
            <span>
              <span className={s.applied ? "font-semibold" : ""}>{s.label}</span> (+<Pct bp={s.bp} />)
              {s.why && !s.label.toLowerCase().includes(s.why.toLowerCase()) ? <> — {s.why}</> : null}
              <span className="sr-only">{s.applied ? " (applied)" : " (not applied)"}</span>
            </span>
          </li>
        ))}
      </ul>

      {open && canChange ? (
        <form onSubmit={submit} className="mt-3 border-t border-line pt-3 space-y-3">
          <div className="grid sm:grid-cols-[140px_minmax(0,1fr)] gap-3">
            <label className="block">
              <span className="label">Bonus (%)</span>
              <input className="input num" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder={(bp / 100).toString()} />
            </label>
            <label className="block">
              <span className="label">Why</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. matching a competitor" maxLength={200} />
            </label>
          </div>
          <div className="hint !mt-0">
            {band ? `Allowed ${fmtBp(band.minBp)}–${fmtBp(band.maxBp)}${band.capRupees ? `, max ₹${band.capRupees.toLocaleString("en-IN")}` : ""}.` : "Within the campaign's band."}
          </div>
          <button className="btn btn-sm btn-up" disabled={busy}>
            {busy ? "Saving…" : "Apply bonus"}
          </button>
        </form>
      ) : null}
      <ErrorText error={err} />
    </div>
  );
}

/** "Upgrade bonus 4% · Diwali Exchange", or why there is none — the trade-in step's line for the bonus. */
export function bonusLine(view: CaseOps["view"]): string | null {
  if (!view.upgrade) return null;
  const b = view.bonus;
  if (!b) return "No bonus campaign today.";
  return `Upgrade bonus ${fmtBp(b.override?.bp ?? b.bp)} · ${b.campaignName}`;
}

/**
 * Estimates what the customer pays for a given new phone price so every model card
 * in the picker and the selected summary shows the live net payable figure immediately.
 */
export function estimateNetCustomerPays(
  newPrice: number,
  currentWePay: number | null | undefined,
  currentBonus: number | null | undefined
): { wePay: number; bonus: number; customerPays: number } {
  const naturalWePay =
    typeof currentWePay === "number" && currentWePay > 0
      ? currentWePay
      : Math.max(2000, Math.round((newPrice * 0.54) / 100) * 100);
  const naturalBonus =
    typeof currentBonus === "number" && currentBonus > 0
      ? currentBonus
      : Math.round((newPrice * 0.04) / 100) * 100;
  const minPayable = Math.max(500, Math.min(2500, Math.round(newPrice * 0.12)));

  let wePay = naturalWePay;
  if (wePay > newPrice - minPayable) {
    wePay = Math.max(1000, Math.round(((newPrice - minPayable) * 0.88) / 100) * 100);
  }
  const maxBonus = Math.max(0, newPrice - wePay - minPayable);
  const bonus = Math.min(naturalBonus, maxBonus);
  const customerPays = Math.max(minPayable, newPrice - wePay - bonus);
  return { wePay, bonus, customerPays };
}

/**
 * The new phone the customer would upgrade to — chosen, or picked from the catalogue — inside
 * the trade-in step or payment screen. Shows live updated net payable prices immediately.
 */
export function NewPhone({ ops, onSwap }: { ops: CaseOps; onSwap?: () => void }) {
  const { view, editable, save } = ops;
  const [devices, setDevices] = useState<NewDeviceView[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(!view.upgrade);

  useEffect(() => {
    if (!editable) return;
    let live = true;
    api<{ devices: NewDeviceView[] }>("/api/catalog/new-devices")
      .then((r) => live && setDevices(r.devices))
      .catch((e) => live && setLoadErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [editable]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (devices ?? []).filter((d) => !needle || `${d.brand} ${d.model} ${d.variant}`.toLowerCase().includes(needle));
    const by = new Map<string, NewDeviceView[]>();
    for (const d of list) by.set(d.series, [...(by.get(d.series) ?? []), d]);
    const order = [...SERIES_ORDER, ...[...by.keys()].filter((s) => !SERIES_ORDER.includes(s)).sort()];
    return order.filter((s) => by.has(s)).map((s) => ({ series: s, items: by.get(s)! }));
  }, [devices, q]);

  async function choose(d: NewDeviceView) {
    setPicking(false);
    const label = `${d.brand} ${d.model} ${d.variant}`;
    const est = estimateNetCustomerPays(d.price, view.offer?.swap.wePay ?? view.quote?.amount, view.offer?.swap.bonus);
    const nextUpgrade = {
      deviceId: d.id,
      label,
      model: d.model,
      series: d.series,
      variant: d.variant,
      price: d.price,
      supportEndYear: d.supportEndYear,
      suggested: false,
    };
    const nextOffer = view.offer
      ? {
          ...view.offer,
          swap: {
            ...view.offer.swap,
            wePay: est.wePay,
            bonus: est.bonus,
            total: est.wePay + est.bonus,
            newPhone: {
              deviceId: d.id,
              label: `${d.model} ${d.variant}`,
              price: d.price,
              suggested: false,
              why: null,
            },
            customerPays: est.customerPays,
            vsRepair:
              view.offer.repair.amount !== null
                ? est.customerPays - view.offer.repair.amount
                : null,
          },
          actions: {
            ...view.offer.actions,
            swap: null,
          },
        }
      : null;

    setErr(
      await save(
        { upgradeDeviceId: d.id },
        {
          status: "quoted",
          upgrade: nextUpgrade,
          ...(nextOffer ? { offer: nextOffer } : {}),
        }
      )
    );
  }

  const up = view.upgrade;
  const line = bonusLine(view);
  const estForSelected = up
    ? estimateNetCustomerPays(up.price ?? 0, view.offer?.swap.wePay ?? view.quote?.amount, view.offer?.swap.bonus)
    : null;
  const effectiveWePay = view.offer?.swap.wePay ?? estForSelected?.wePay ?? null;
  const effectiveBonus = view.offer?.swap.bonus ?? estForSelected?.bonus ?? 0;
  const effectiveCustomerPays =
    view.offer?.swap.customerPays !== null && view.offer?.swap.customerPays !== undefined
      ? view.offer.swap.customerPays
      : (estForSelected?.customerPays ?? null);

  return (
    <div>
      <div className="label">New phone</div>
      {up && !picking ? (
        <div className="rounded-[12px] border-[1.5px] border-[color:var(--up)] bg-up-bg px-4 py-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[17px] font-[720] leading-tight">
                  {up.model} {up.variant}
                </span>
                {up.suggested ? <span className="pill pill-fix">Suggested</span> : null}
              </div>
              <div className="text-[13.5px] text-ink-2 mt-0.5">
                Catalogue price: <Money value={up.price} className="font-semibold text-ink" />
              </div>
            </div>
            {editable ? (
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
                  Change model
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={async () => setErr(await save({ upgradeDeviceId: null }, { upgrade: null, bonus: null }))}>
                  Clear
                </button>
              </div>
            ) : null}
          </div>

          {/* Live Updated Price Breakdown for the Selected Model */}
          <div className="rounded-[10px] border border-line bg-surface px-3.5 py-2.5 space-y-1.5 text-[13.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-2">New phone price ({up.model} {up.variant})</span>
              <Money value={up.price} className="font-semibold" />
            </div>
            {effectiveWePay !== null ? (
              <div className="flex items-center justify-between gap-2 text-up">
                <span>Less trade-in value (We pay you)</span>
                <span className="num font-semibold">− <Money value={effectiveWePay} /></span>
              </div>
            ) : null}
            {effectiveBonus && effectiveBonus > 0 ? (
              <div className="flex items-center justify-between gap-2 text-up">
                <span>Less upgrade bonus</span>
                <span className="num font-semibold">− <Money value={effectiveBonus} /></span>
              </div>
            ) : null}
            {effectiveCustomerPays !== null ? (
              <div className="flex items-center justify-between gap-2 border-t border-line pt-1.5 text-[15px] font-[760] text-ink">
                <span>Updated Customer Pays (Complete Payment)</span>
                <Money value={effectiveCustomerPays} className="text-[17px] text-up" />
              </div>
            ) : null}
          </div>

          {editable && onSwap ? (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
              <button
                type="button"
                className="btn btn-up w-full sm:w-auto"
                onClick={onSwap}
              >
                Swap up (Complete payment · <Money value={effectiveCustomerPays} />) →
              </button>
            </div>
          ) : null}
        </div>
      ) : !editable ? (
        <p className="text-[14px] text-muted">No new phone chosen.</p>
      ) : (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input className="input max-w-[320px]" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. S25 or 256GB" aria-label="Search new phones" />
            {up ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(false)}>
                Keep {up.model}
              </button>
            ) : null}
          </div>
          {loadErr ? <ErrorText error={loadErr} /> : null}
          {devices === null && !loadErr ? <p className="hint">Loading…</p> : null}
          {devices && groups.length === 0 ? <p className="hint">No new phone matches &ldquo;{q}&rdquo;.</p> : null}
          <div className="max-h-[460px] overflow-y-auto -mx-1 px-1 space-y-4">
            {groups.map((g) => (
              <div key={g.series}>
                <div className="section-title mb-2">{seriesHeading(g.series)}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {g.items.map((d) => {
                    const sel = up?.deviceId === d.id;
                    const est = estimateNetCustomerPays(d.price, view.offer?.swap.wePay ?? view.quote?.amount, view.offer?.swap.bonus);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => choose(d)}
                        aria-pressed={sel}
                        className={`text-left rounded-[11px] border-[1.5px] px-3 py-2.5 min-h-[72px] min-w-0 ${
                          sel ? "border-[color:var(--up)] bg-up-bg" : "border-[color:var(--line-2)] bg-surface hover:border-[color:var(--ink)]"
                        }`}
                      >
                        <span className="block text-[14px] font-semibold leading-tight">{d.model}</span>
                        <span className="block text-[12px] text-muted">{d.variant}</span>
                        <span className="block text-[13px] text-ink-2 mt-0.5">
                          MRP <Money value={d.price} />
                        </span>
                        <span className="block text-[13px] font-[720] text-up mt-0.5">
                          Pay <Money value={est.customerPays} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {devices?.[0]?.source?.label ? <p className="hint">Prices: {devices[0].source.label}.</p> : null}
        </div>
      )}
      {line ? <p className="text-[14px] text-ink-2 mt-2">{line}</p> : null}
      <ErrorText error={err} />
    </div>
  );
}
