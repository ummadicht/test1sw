"use client";

import { Field } from "@/components/ui";
import { SERIES, SERIES_LABEL, STORE_KINDS, STORE_KIND_LABEL } from "@/components/admin/format";
import { COND_KINDS, COND_LABEL, blankRule, type CondKind, type Draft, type RuleDraft } from "@/components/admin/campaignDraft";
import { fmtBp } from "@/lib/domain/money";

/** The campaign form. Holds no state of its own — the console owns the draft. */
export function CampaignEditor({
  draft,
  onChange,
  band,
  brands,
  isPlatform,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  band: { minBp: number; maxBp: number };
  brands: string[];
  isPlatform: boolean;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  const setRule = (i: number, patch: Partial<RuleDraft>) => onChange({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= draft.rules.length) return;
    const rules = [...draft.rules];
    [rules[i], rules[j]] = [rules[j], rules[i]];
    onChange({ ...draft, rules });
  };

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Field label="Campaign name">
            <input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Repair-to-upgrade bonus" maxLength={80} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <span className="label">The bonus is a percentage of</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Bonus basis">
            {(
              [
                ["new_price", "the new phone's price"],
                ["trade_in_value", "the trade-in value"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={draft.basis === v} aria-pressed={draft.basis === v} className="chip" onClick={() => set("basis", v)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <Field label="Minimum bonus (%)" hint={`Programme band ${fmtBp(band.minBp)}–${fmtBp(band.maxBp)}`}>
          <input className="input num" inputMode="decimal" value={draft.minPct} onChange={(e) => set("minPct", e.target.value)} />
        </Field>
        <Field label="Maximum bonus (%)" hint={isPlatform ? "The band is set on Settings." : "The band is set by SwapUp."}>
          <input className="input num" inputMode="decimal" value={draft.maxPct} onChange={(e) => set("maxPct", e.target.value)} />
        </Field>
        <Field label="Cap per upgrade (₹, optional)" hint="Leave blank for no rupee ceiling.">
          <input className="input num" inputMode="numeric" value={draft.cap} onChange={(e) => set("cap", e.target.value)} placeholder="no cap" />
        </Field>
        <Field label="Funded by" hint="Who the stores claim the bonus back from.">
          <input className="input" value={draft.fundedBy} onChange={(e) => set("fundedBy", e.target.value)} placeholder="e.g. Brand (claimed monthly)" maxLength={120} />
        </Field>
        <Field label="Starts on">
          <input className="input" type="date" value={draft.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
        </Field>
        <Field label="Ends on (optional)" hint="Leave blank to run until you pause it.">
          <input className="input" type="date" value={draft.endsOn} min={draft.startsOn || undefined} onChange={(e) => set("endsOn", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <span className="label">At the counter</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="chip" aria-pressed={draft.active} onClick={() => set("active", true)}>
              On — offer it
            </button>
            <button type="button" className="chip" aria-pressed={!draft.active} onClick={() => set("active", false)}>
              Paused
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <div className="section-title">Rules</div>
            <p className="hint !mt-0.5">Each rule that applies adds its %. The total is then held inside the minimum and maximum above.</p>
          </div>
        </div>
        <ol className="space-y-3">
          {draft.rules.map((r, i) => (
            <li key={r.id} className="rounded-[12px] border border-line p-3.5 bg-[color:var(--surface)]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink-2">Rule {i + 1}</span>
                <div className="flex gap-1">
                  <button type="button" className="btn btn-sm btn-ghost !px-2.5" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move rule ${i + 1} up`}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost !px-2.5"
                    onClick={() => move(i, 1)}
                    disabled={i === draft.rules.length - 1}
                    aria-label={`Move rule ${i + 1} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onChange({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
                    aria-label={`Remove rule ${i + 1}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <label className="block">
                  <span className="label">What the advisor says</span>
                  <input className="input" value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} placeholder="e.g. Upgrading to a Galaxy S or Z" maxLength={120} />
                </label>
                <label className="block">
                  <span className="label">Adds (%)</span>
                  <input className="input num" inputMode="decimal" value={r.pct} onChange={(e) => setRule(i, { pct: e.target.value })} placeholder="1" />
                </label>
              </div>
              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="label">Applies when</span>
                  <select className="select" value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value as CondKind })}>
                    {COND_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {COND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <ConditionParams r={r} brands={brands} onChange={(p) => setRule(i, p)} />
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2 mt-3">
          <button type="button" className="btn btn-sm" onClick={() => onChange({ ...draft, rules: [...draft.rules, blankRule("target_series")] })}>
            + Add a rule
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionParams({ r, brands, onChange }: { r: RuleDraft; brands: string[]; onChange: (p: Partial<RuleDraft>) => void }) {
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  switch (r.kind) {
    case "always":
      return <p className="hint !mt-0">Applies to every upgrade — use it for the base rate.</p>;
    case "old_brand":
      return (
        <label className="block">
          <span className="label">Brands (comma-separated)</span>
          <input className="input" value={r.brands} onChange={(e) => onChange({ brands: e.target.value })} placeholder="Apple, OnePlus, Xiaomi" list="swapup-brands" />
          <datalist id="swapup-brands">
            {brands.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <span className="hint">Brand names as the trade-in catalogue spells them: {brands.slice(0, 8).join(", ")}{brands.length > 8 ? "…" : ""}</span>
        </label>
      );
    case "target_series":
      return (
        <div>
          <span className="label">New phone series</span>
          <div className="flex flex-wrap gap-2">
            {SERIES.map((s) => (
              <button key={s} type="button" className="chip !min-h-[38px]" aria-pressed={r.series.includes(s)} onClick={() => onChange({ series: toggle(r.series, s) })}>
                {SERIES_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      );
    case "old_age_years_gte":
      return (
        <label className="block max-w-[220px]">
          <span className="label">Old phone at least (years)</span>
          <input className="input num" inputMode="decimal" value={r.years} onChange={(e) => onChange({ years: e.target.value })} placeholder="4" />
        </label>
      );
    case "repair_ratio_gte":
      return (
        <label className="block max-w-[260px]">
          <span className="label">Repair costs at least (% of repaired value)</span>
          <input className="input num" inputMode="decimal" value={r.ratioPct} onChange={(e) => onChange({ ratioPct: e.target.value })} placeholder="50" />
        </label>
      );
    case "store_kind":
      return (
        <div>
          <span className="label">Store types</span>
          <div className="flex flex-wrap gap-2">
            {STORE_KINDS.map((k) => (
              <button key={k} type="button" className="chip !min-h-[38px]" aria-pressed={r.kinds.includes(k)} onClick={() => onChange({ kinds: toggle(r.kinds, k) })}>
                {STORE_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      );
  }
}
