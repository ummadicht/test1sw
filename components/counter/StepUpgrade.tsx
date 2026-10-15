"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { Money, Pct, ErrorText } from "@/components/ui";
import { pctToBp, fmtBp } from "@/lib/domain/money";
import type { NewDeviceView } from "@/lib/server/catalog";
import { StepCard } from "./StepCard";
import { SERIES_ORDER, seriesHeading } from "./shared";
import type { CaseOps, CampaignBand } from "./ops";

const CLAMP_NOTE: Record<string, string> = {
  min: "Raised to the campaign's minimum.",
  max: "Capped at the campaign's maximum.",
  cap: "Capped at the campaign's rupee limit per upgrade.",
};

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
    if (!pct.trim() || !Number.isFinite(p)) return setErr("Enter the bonus as a percentage, e.g. 4 or 4.5.");
    const newBp = pctToBp(p);
    if (band && (newBp < band.minBp || newBp > band.maxBp)) return setErr(`The bonus must stay inside the campaign band (${fmtBp(band.minBp)}–${fmtBp(band.maxBp)}).`);
    if (reason.trim().length < 8) return setErr("Say why this customer gets a different bonus.");
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
    <div className="mt-4 rounded-[12px] border border-[color:color-mix(in_srgb,var(--up)_30%,transparent)] bg-up-bg px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-title !text-[color:var(--up-strong)]">Upgrade bonus · a promotion</div>
          <div className="text-[24px] font-[760] text-up leading-tight mt-0.5">
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
              <span className={s.applied ? "font-semibold" : ""}>{s.label}</span> (+<Pct bp={s.bp} />) — {s.why}
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
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. matching a competitor's exchange offer" maxLength={200} />
            </label>
          </div>
          <div className="hint !mt-0">
            {band ? `Allowed for this campaign: ${fmtBp(band.minBp)} to ${fmtBp(band.maxBp)}${band.capRupees ? `, at most ₹${band.capRupees.toLocaleString("en-IN")}` : ""}.` : "Must stay inside the campaign's band."}{" "}
            Recorded with your name.
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

/** ⑥ The new phone the customer would upgrade to, and the upgrade bonus on it. */
export function StepUpgrade({ ops, isManager, bands }: { ops: CaseOps; isManager: boolean; bands: Record<string, CampaignBand> }) {
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
        { upgrade: { deviceId: d.id, label: `${d.brand} ${d.model} ${d.variant}`, model: d.model, series: d.series, variant: d.variant, price: d.price, supportEndYear: d.supportEndYear } }
      )
    );
  }

  const up = view.upgrade;
  const band = view.bonus ? (bands[view.bonus.campaignId] ?? null) : null;

  return (
    <StepCard n={6} id="step-upgrade" title="New phone" done={!!up}>
      {up && !picking ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border-[1.5px] border-[color:var(--up)] bg-up-bg px-4 py-3">
          <div className="min-w-0">
            <div className="text-[18px] font-[720] leading-tight">{up.label}</div>
            <div className="text-[13px] text-ink-2">
              <Money value={up.price} className="font-semibold" />
              {up.supportEndYear ? ` · security updates until ${up.supportEndYear}` : ""}
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
          {devices === null && !loadErr ? <p className="hint">Loading the catalogue…</p> : null}
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
                        className={`text-left rounded-[11px] border-[1.5px] px-3 py-2.5 min-h-[64px] ${
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

      {up && view.bonus ? <BonusBlock ops={ops} isManager={isManager} band={band} /> : null}
      {up && !view.bonus ? <p className="hint mt-3">No upgrade-bonus campaign applies to this phone today.</p> : null}
      <ErrorText error={err} />
    </StepCard>
  );
}
