"use client";

import { useMemo, useState } from "react";
import { Card, Empty, Money, SourceBadge } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type { TradeModelAdminView } from "@/lib/server/admin-extra";
import { TIER_LABEL } from "@/components/admin/format";

const PAGE = 25;

/** TRADE-IN MODELS — the phones the counter can identify and price for trade-in. Read-only; SwapUp maintains it. */
export function TradeModelsTab({ models, labourByTier, carePlusDefault }: { models: TradeModelAdminView[]; labourByTier: Record<string, number>; carePlusDefault: number }) {
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [page, setPage] = useState(0);
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
    <div className="space-y-4">
      <p className="text-ink-2 text-[14.5px] max-w-[80ch]">
        Phones the counter takes in trade. Missing one? Tell us.
        {approxCount ? ` ${approxCount} with an approximate release year.` : ""}
      </p>
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
              placeholder="Model name, e.g. A54"
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
