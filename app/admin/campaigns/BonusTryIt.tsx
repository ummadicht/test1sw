"use client";

import { useMemo, useState } from "react";
import { computeBonus, type Campaign } from "@/lib/domain/bonus";
import { fmtBp, inr } from "@/lib/domain/money";
import { Money, Pct } from "@/components/ui";
import { SERIES, SERIES_LABEL, STORE_KINDS, STORE_KIND_LABEL, parsePct, parseRupees } from "@/components/admin/format";

export type PhoneOption = { id: string; label: string; price: number; series: string };

/**
 * "Try it": runs the SAME computeBonus the counter runs, on the campaign as it
 * is being edited, for a customer the admin describes. Nothing is saved.
 */
export function BonusTryIt({
  campaign,
  hasErrors,
  notLiveReason,
  phones,
  brands,
  defaultStoreKind,
  today,
}: {
  campaign: Campaign;
  hasErrors: boolean;
  notLiveReason: string | null;
  phones: PhoneOption[];
  brands: string[];
  defaultStoreKind: string;
  today: string;
}) {
  const first = phones[0];
  const [phoneId, setPhoneId] = useState(first?.id ?? "");
  const [newPrice, setNewPrice] = useState(first ? String(first.price) : "");
  const [series, setSeries] = useState(first?.series ?? "S");
  const [tradeIn, setTradeIn] = useState("");
  const [oldBrand, setOldBrand] = useState(brands[0] ?? "Samsung");
  const [age, setAge] = useState("");
  const [ratio, setRatio] = useState("");
  const [storeKind, setStoreKind] = useState(defaultStoreKind);

  const price = parseRupees(newPrice) ?? 0;
  const trade = parseRupees(tradeIn) ?? 0;
  const ageN = age.trim() === "" ? null : Number(age);
  const ratioP = parsePct(ratio);

  const result = useMemo(
    () =>
      computeBonus(campaign, {
        today,
        oldBrand,
        oldAgeYears: ageN !== null && Number.isFinite(ageN) ? ageN : null,
        targetSeries: series,
        newPrice: price,
        tradeInValue: trade,
        repairRatio: ratioP === null ? null : ratioP / 100,
        storeKind,
      }),
    [campaign, today, oldBrand, ageN, series, price, trade, ratioP, storeKind]
  );
  const raw = result.steps.filter((s) => s.applied).reduce((t, s) => t + s.bp, 0);
  const basisMissing = campaign.basis === "trade_in_value" ? trade <= 0 : price <= 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="label">New phone</span>
          <select
            className="select"
            value={phoneId}
            onChange={(e) => {
              setPhoneId(e.target.value);
              const p = phones.find((x) => x.id === e.target.value);
              if (p) {
                setNewPrice(String(p.price));
                setSeries(p.series);
              }
            }}
          >
            <option value="">Type a price instead…</option>
            {phones.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {inr(p.price)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">New phone price (₹)</span>
          <input
            className="input num"
            inputMode="numeric"
            value={newPrice}
            onChange={(e) => {
              setNewPrice(e.target.value);
              setPhoneId("");
            }}
          />
        </label>
        <label className="block">
          <span className="label">Trade-in value (₹)</span>
          <input className="input num" inputMode="numeric" value={tradeIn} onChange={(e) => setTradeIn(e.target.value)} placeholder="optional" />
        </label>
        <div className="col-span-2">
          <span className="label">New phone series</span>
          <div className="flex flex-wrap gap-2">
            {SERIES.map((s) => (
              <button
                key={s}
                type="button"
                className="chip !min-h-[36px] !px-3"
                aria-pressed={series === s}
                onClick={() => {
                  setSeries(s);
                  setPhoneId("");
                }}
                title={SERIES_LABEL[s]}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="label">Old phone brand</span>
          <select className="select" value={oldBrand} onChange={(e) => setOldBrand(e.target.value)}>
            {(brands.length ? brands : ["Samsung"]).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Old phone age (yrs)</span>
          <input className="input num" inputMode="decimal" value={age} onChange={(e) => setAge(e.target.value)} placeholder="unknown" />
        </label>
        <label className="block">
          <span className="label">Repair share (%)</span>
          <input className="input num" inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} placeholder="no quote" />
        </label>
        <label className="block">
          <span className="label">Store type</span>
          <select className="select" value={storeKind} onChange={(e) => setStoreKind(e.target.value)}>
            {STORE_KINDS.map((k) => (
              <option key={k} value={k}>
                {STORE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint !mt-0">Repair share = repair cost ÷ what the phone is worth once repaired, as the counter works it out.</p>

      <div className="rounded-[12px] border border-line bg-up-bg/60 p-4" aria-live="polite">
        <div className="section-title">This customer would get</div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-1">
          <span className="kpi text-up">
            <Money value={result.amount} />
          </span>
          <span className="text-[17px] font-semibold text-ink-2">
            <Pct bp={result.bp} />
          </span>
        </div>
        <div className="hint !mt-1">
          {fmtBp(result.bp)} of {inr(result.basisAmount)} ({campaign.basis === "new_price" ? "new phone price" : "trade-in value"}), rounded down
          {result.fundedBy ? <> · funded by {result.fundedBy}</> : null}
        </div>
        {basisMissing ? (
          <p className="hint !mt-2 !text-[color:var(--warn)]">
            Enter the {campaign.basis === "new_price" ? "new phone price" : "trade-in value"} — this campaign is a percentage of it.
          </p>
        ) : null}
        {result.clampedBy === "min" ? (
          <p className="text-[13.5px] mt-2 text-ink-2">
            The rules that apply add up to {fmtBp(raw)}, below the campaign minimum — the customer gets the minimum, {fmtBp(campaign.minBp)}.
          </p>
        ) : result.clampedBy === "max" ? (
          <p className="text-[13.5px] mt-2 text-ink-2">
            The rules that apply add up to {fmtBp(raw)} — held to the campaign maximum of {fmtBp(campaign.maxBp)}.
          </p>
        ) : result.clampedBy === "cap" ? (
          <p className="text-[13.5px] mt-2 text-ink-2">
            {fmtBp(result.bp)} would be more than the {inr(campaign.capRupees)} per-upgrade cap, so the bonus is the cap.
          </p>
        ) : null}
      </div>

      <div>
        <div className="section-title mb-2">How the counter works it out</div>
        {result.steps.length ? (
          <ol className="space-y-1.5">
            {result.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[14px]">
                <span aria-hidden className={`mt-0.5 w-5 shrink-0 text-center font-bold ${s.applied ? "text-up" : "text-muted"}`}>
                  {s.applied ? "✓" : "–"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={s.applied ? "font-semibold" : "text-muted"}>{s.label || `Rule ${i + 1}`}</span>
                  <span className="block text-[12.5px] text-muted">{s.why}</span>
                </span>
                <span className={`num shrink-0 ${s.applied ? "text-up font-semibold" : "text-muted line-through"}`}>+{fmtBp(s.bp)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="hint">Add a rule to see it here.</p>
        )}
      </div>

      {hasErrors ? <p className="hint !text-[color:var(--warn)]">The campaign has problems (listed under the editor). This figure uses the rules exactly as typed.</p> : null}
      {notLiveReason ? <p className="hint">Not offered at the counter today: {notLiveReason.toLowerCase()}.</p> : null}
    </div>
  );
}
