"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Field, Money, SourceBadge } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type { TradeModelAdminView } from "@/lib/server/admin-extra";
import { SERIES, SERIES_LABEL, TIER_LABEL, parseRupees } from "@/components/admin/format";

const PAGE = 25;

const BRAND_OPTIONS = ["Samsung", "Apple", "OnePlus", "Xiaomi", "Vivo", "Oppo", "Realme", "Google", "Motorola", "Nothing"] as const;

type Res = { models: TradeModelAdminView[] };

/** TRADE-IN MODELS — the phones the counter can identify and price for trade-in. */
export function TradeModelsTab({
  models: initialModels,
  labourByTier,
  carePlusDefault,
}: {
  models: TradeModelAdminView[];
  labourByTier: Record<string, number>;
  carePlusDefault: number;
}) {
  const [models, setModels] = useState(initialModels);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const brands = useMemo(() => [...new Set(models.map((m) => m.brand))], [models]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return models.filter((m) => (!brand || m.brand === brand) && (!t || `${m.brand} ${m.model} ${m.id}`.toLowerCase().includes(t)));
  }, [models, q, brand]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pages - 1);
  const rows = filtered.slice(p * PAGE, p * PAGE + PAGE);
  const approxCount = models.filter((m) => m.source?.kind === "approximate").length;

  return (
    <div className="space-y-5">
      {notice ? <Banner tone="up">{notice}</Banner> : null}

      <p className="text-ink-2 text-[14.5px] max-w-[80ch]">
        Phones the counter takes in trade and prices for repair or upgrade. Add a new trade-in model below to make it immediately available at the counter.
        {approxCount ? ` ${approxCount} with an approximate release year.` : ""}
      </p>

      <Card title="Add a trade-in model">
        <AddTradeModelForm
          carePlusDefault={carePlusDefault}
          onSaved={(list, msg) => {
            setModels(list);
            setNotice(msg);
          }}
        />
      </Card>

      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 px-5 pt-4 pb-3">
          <label className="block flex-1 min-w-[200px] max-w-[360px]">
            <span className="label">Search</span>
            <input
              className="input !min-h-[40px]"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="Model name, e.g. Note 9 or A54"
            />
          </label>
          <label className="block">
            <span className="label">Brand</span>
            <select
              className="select !min-h-[40px]"
              value={brand}
              onChange={(e) => {
                setBrand(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <span className="hint sm:ml-auto !mb-2.5">
            {filtered.length} of {models.length} models
          </span>
        </div>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="table min-w-[960px]">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Released</th>
                  <th className="text-right">Security updates until</th>
                  <th>Service tier</th>
                  <th className="text-right">Care+ claim fee</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="font-semibold">
                        {m.brand} {m.model}
                      </div>
                      <div className="hint !mt-0.5">{m.variants.join(" · ") || "—"}</div>
                    </td>
                    <td className="text-right num">{m.releaseYear ?? "—"}</td>
                    <td className="text-right num">{m.supportEndYear ?? <span className="text-muted">not recorded</span>}</td>
                    <td>
                      {TIER_LABEL[m.serviceTier] ?? m.serviceTier}
                      <div className="hint !mt-0.5">labour {inr(labourByTier[m.serviceTier] ?? labourByTier.other ?? null)}</div>
                    </td>
                    <td className="text-right">
                      {m.carePlusFee !== null ? (
                        <Money value={m.carePlusFee} />
                      ) : (
                        <span className="text-muted" title="Uses the default plan fee">
                          default {inr(carePlusDefault)}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[320px]">
                      {m.source ? (
                        <div className="space-y-0.5">
                          {m.source.kind === "approximate" ? <SourceBadge kind="approximate" label={m.source.label} /> : null}
                          <div className="text-[12.5px] text-ink-2">
                            {m.source.url ? (
                              <a href={m.source.url} target="_blank" rel="noreferrer noopener">
                                {m.source.label} ↗
                              </a>
                            ) : (
                              m.source.label
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted">Not recorded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No model matches">Try fewer letters, or another brand.</Empty>
        )}
        {pages > 1 ? (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-line">
            <button type="button" className="btn btn-sm" onClick={() => setPage(p - 1)} disabled={p === 0}>
              ← Previous
            </button>
            <span className="text-[13px] text-ink-2">
              Page {p + 1} of {pages}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setPage(p + 1)} disabled={p >= pages - 1}>
              Next →
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

const BLANK_TRADE = {
  brand: "Samsung",
  model: "",
  series: "S",
  variants: "128GB, 256GB",
  releaseYear: "",
  supportEndYear: "",
  serviceTier: "S",
  maxTradePrice: "",
  carePlusFee: "",
  sourceLabel: "",
};

function AddTradeModelForm({
  carePlusDefault,
  onSaved,
}: {
  carePlusDefault: number;
  onSaved: (list: TradeModelAdminView[], msg: string) => void;
}) {
  const [f, setF] = useState(BLANK_TRADE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof BLANK_TRADE) => (e: { target: { value: string } }) =>
    setF((prev) => {
      const next = { ...prev, [k]: e.target.value };
      if (k === "series") {
        next.serviceTier = e.target.value === "Z" ? "Z" : e.target.value === "S" ? "S" : "other";
      }
      if (k === "brand" && e.target.value !== "Samsung") {
        next.series = "";
        next.serviceTier = "other";
      }
      return next;
    });

  const ry = f.releaseYear.trim() ? Number(f.releaseYear) : null;
  const sey = f.supportEndYear.trim() ? Number(f.supportEndYear) : null;
  const maxTradePrice = f.maxTradePrice.trim() ? parseRupees(f.maxTradePrice) : null;
  const carePlusFee = f.carePlusFee.trim() ? parseRupees(f.carePlusFee) : null;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (f.model.trim().length < 2) return setError("Enter a model name (e.g. Galaxy Note 9).");
        if (!f.variants.trim()) return setError("Enter at least one storage variant (e.g. 128GB, 256GB).");
        if (ry !== null && (!Number.isInteger(ry) || ry < 2015 || ry > 2035)) {
          return setError("Release year should be between 2015 and 2035.");
        }
        if (sey !== null && (!Number.isInteger(sey) || sey < 2018 || sey > 2045)) {
          return setError("Security updates end year should be between 2018 and 2045.");
        }
        if (f.maxTradePrice.trim() && (maxTradePrice === null || maxTradePrice <= 0)) {
          return setError("Base trade-in value must be a whole rupee amount.");
        }

        setBusy(true);
        try {
          const r = await api<Res>("/api/admin/trade-models", {
            body: {
              brand: f.brand,
              model: f.model.trim(),
              series: f.brand === "Samsung" && f.series ? f.series : null,
              variants: f.variants,
              releaseYear: ry,
              supportEndYear: sey,
              serviceTier: f.serviceTier,
              maxTradePrice,
              carePlusFee,
              sourceLabel: f.sourceLabel.trim() || undefined,
            },
          });
          onSaved(
            r.models,
            `Added trade-in model ${f.brand} ${f.model.trim()} (${f.variants.trim()})${maxTradePrice ? ` with base buyback ${inr(maxTradePrice)}` : ""}.`
          );
          setF(BLANK_TRADE);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Field label="Brand">
          <select className="select" value={f.brand} onChange={set("brand")}>
            {BRAND_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <input
            className="input"
            value={f.model}
            onChange={set("model")}
            placeholder="e.g. Galaxy Note 9 or iPhone 15"
            required
            minLength={2}
            maxLength={60}
          />
        </Field>
        <Field label="Series">
          <select className="select" value={f.series} onChange={set("series")} disabled={f.brand !== "Samsung"}>
            {f.brand === "Samsung" ? (
              SERIES.map((s) => (
                <option key={s} value={s}>
                  {SERIES_LABEL[s]}
                </option>
              ))
            ) : (
              <option value="">Non-Galaxy</option>
            )}
          </select>
        </Field>
        <Field label="Variants (comma-separated)" hint="e.g. 128GB, 256GB or 6GB+128GB, 8GB+512GB">
          <input
            className="input"
            value={f.variants}
            onChange={set("variants")}
            placeholder="e.g. 128GB, 256GB"
            required
            minLength={2}
            maxLength={120}
          />
        </Field>
        <Field label="Base trade-in value (₹)" hint="Top 'Like New' buyback value; auto-populates active rate card.">
          <input
            className="input num"
            inputMode="numeric"
            value={f.maxTradePrice}
            onChange={set("maxTradePrice")}
            placeholder="e.g. 18000 (optional)"
          />
        </Field>
        <Field label="Service tier">
          <select className="select" value={f.serviceTier} onChange={set("serviceTier")}>
            <option value="S">Galaxy S / Note</option>
            <option value="Z">Galaxy Z (Fold / Flip)</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Release year" hint="Optional, e.g. 2018 or 2025">
          <input
            className="input num"
            inputMode="numeric"
            value={f.releaseYear}
            onChange={set("releaseYear")}
            placeholder="e.g. 2024"
            maxLength={4}
          />
        </Field>
        <Field label="Security updates until (year)" hint="Optional, e.g. 2031">
          <input
            className="input num"
            inputMode="numeric"
            value={f.supportEndYear}
            onChange={set("supportEndYear")}
            placeholder="e.g. 2031"
            maxLength={4}
          />
        </Field>
        <Field label="Care+ claim fee (₹)" hint={`Leave blank to use default (${inr(carePlusDefault)})`}>
          <input
            className="input num"
            inputMode="numeric"
            value={f.carePlusFee}
            onChange={set("carePlusFee")}
            placeholder={`Default ${inr(carePlusDefault)}`}
          />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy || f.model.trim().length < 2 || f.variants.trim().length < 2}>
        {busy ? "Adding…" : "Add trade-in model"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}
