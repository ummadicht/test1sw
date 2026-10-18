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
 * The new phone the customer would upgrade to — chosen, or picked from the catalogue — inside
 * the trade-in step. Its price is the catalogue's; what the customer pays is the answer's.
 */
export function NewPhone({ ops }: { ops: CaseOps }) {
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
    setErr(
      await save(
        { upgradeDeviceId: d.id },
        // A staff choice is never "suggested" — it stands across later storage changes.
        { upgrade: { deviceId: d.id, label: `${d.brand} ${d.model} ${d.variant}`, model: d.model, series: d.series, variant: d.variant, price: d.price, supportEndYear: d.supportEndYear, suggested: false } }
      )
    );
  }

  const up = view.upgrade;
  const line = bonusLine(view);

  return (
    <div>
      <div className="label">New phone</div>
      {up && !picking ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border-[1.5px] border-[color:var(--up)] bg-up-bg px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[17px] font-[720] leading-tight">
                {up.model} {up.variant}
              </span>
              {up.suggested ? <span className="pill pill-fix">Suggested</span> : null}
            </div>
            <div className="text-[13.5px] text-ink-2">
              <Money value={up.price} />
            </div>
          </div>
          {editable ? (
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
                Change
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={async () => setErr(await save({ upgradeDeviceId: null }, { upgrade: null, bonus: null }))}>
                Clear
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
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => choose(d)}
                        aria-pressed={sel}
                        className={`text-left rounded-[11px] border-[1.5px] px-3 py-2.5 min-h-[64px] min-w-0 ${
                          sel ? "border-[color:var(--up)] bg-up-bg" : "border-[color:var(--line-2)] bg-surface hover:border-[color:var(--ink)]"
                        }`}
                      >
                        <span className="block text-[14px] font-semibold leading-tight">{d.model}</span>
                        <span className="block text-[12px] text-muted">{d.variant}</span>
                        <span className="block text-[14px] mt-0.5">
                          <Money value={d.price} />
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
