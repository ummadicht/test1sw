"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Field, Money, SourceBadge } from "@/components/ui";
import { PART_LABEL, type PartId } from "@/lib/domain/condition";
import { fmtBp, inr } from "@/lib/domain/money";
import type { RepairPriceView, TradeModelView } from "@/lib/server/catalog";
import { TIER_LABEL, fmtDay, parseRupees, withOrg } from "@/components/admin/format";
import { RupeeInput } from "@/components/admin/RupeeInput";

export type RepairModel = { id: string; brand: string; model: string; releaseYear: number | null; serviceTier: string; carePlusFee: number | null };

type Res = { rows: RepairPriceView[] };

/** REPAIR PRICE BOOK — part list prices per model, which the counter turns into a repair quote. */
export function RepairBookTab({
  orgId,
  isPlatform,
  model,
  initialRows,
  bookModels,
  labourByTier,
  gstBp,
}: {
  orgId: string;
  isPlatform: boolean;
  model: RepairModel | null;
  initialRows: RepairPriceView[];
  bookModels: { modelId: string; label: string; count: number }[];
  labourByTier: Record<string, number>;
  gstBp: number;
}) {
  const [rows, setRows] = useState(initialRows);
  const [notice, setNotice] = useState<string | null>(null);
  const org = isPlatform ? orgId : undefined;
  const href = (modelId: string) => withOrg("/admin/catalogue", orgId, isPlatform, { tab: "repair", modelId });
  const labour = model ? labourByTier[model.serviceTier] ?? labourByTier.other ?? null : null;

  return (
    <div className="space-y-5">
      <Banner>
        <strong>Samsung part list prices</strong>, before labour and GST ({fmtBp(gstBp)}).
      </Banner>

      <Card title="Find a model">
        <ModelSearch hrefFor={href} initial={model ? `${model.brand} ${model.model}` : ""} />
        {!model && bookModels.length ? (
          <div className="mt-5">
            <div className="section-title mb-2">
              {bookModels.length} model{bookModels.length === 1 ? "" : "s"} in your price book
            </div>
            <div className="flex flex-wrap gap-2 max-h-[320px] overflow-y-auto">
              {bookModels.map((m) => (
                <Link key={m.modelId} href={href(m.modelId)} className="pill no-underline hover:bg-[color:var(--line)]">
                  {m.label} <span className="text-muted num">{m.count}</span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {model ? (
        <>
          {notice ? <Banner tone="up">{notice}</Banner> : null}
          <Card
            title={`${model.brand} ${model.model}`}
            action={
              <span className="text-[13px] text-ink-2 text-right">
                {TIER_LABEL[model.serviceTier] ?? model.serviceTier} tier · labour {labour === null ? "—" : inr(labour)} per job
                {model.releaseYear ? ` · released ${model.releaseYear}` : ""}
              </span>
            }
            pad={false}
          >
            {rows.length ? (
              <div className="overflow-x-auto">
                <table className="table min-w-[760px]">
                  <thead>
                    <tr>
                      <th>Part</th>
                      <th className="w-[260px]">List price (excl. GST)</th>
                      <th>Source</th>
                      <th className="w-[90px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <PartRow
                        key={r.part}
                        r={r}
                        org={org}
                        onSaved={(list, msg) => {
                          setRows(list);
                          setNotice(msg);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No part prices for this model yet">
                Repairs show unpriced until you add them below.
              </Empty>
            )}
          </Card>
          <Card title="Add a part price">
            <AddPartForm
              org={org}
              modelId={model.id}
              have={rows.map((r) => r.part)}
              onSaved={(list, msg) => {
                setRows(list);
                setNotice(msg);
              }}
            />
          </Card>
        </>
      ) : null}
    </div>
  );
}

function ModelSearch({ hrefFor, initial }: { hrefFor: (id: string) => string; initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [hits, setHits] = useState<TradeModelView[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = q.trim();
    if (!touched || t.length < 2) {
      setHits([]);
      return;
    }
    const my = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await api<{ models: TradeModelView[] }>(`/api/catalog/models?q=${encodeURIComponent(t)}`);
        if (my === seq.current) {
          setHits(r.models.slice(0, 10));
          setCursor(0);
          setOpen(true);
          setError(null);
        }
      } catch (err) {
        if (my === seq.current) setError((err as Error).message);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [q, touched]);

  const pick = (m: TradeModelView) => {
    setOpen(false);
    setQ(`${m.brand} ${m.model}`);
    router.push(hrefFor(m.id));
  };

  return (
    <div className="relative max-w-[520px]">
      <label className="block">
        <span className="label">Model</span>
        <input
          className="input"
          value={q}
          placeholder="Type a model, e.g. S23 or Fold5"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls="repair-model-list"
          aria-autocomplete="list"
          onChange={(e) => {
            setTouched(true);
            setQ(e.target.value);
          }}
          onFocus={(e) => {
            if (hits.length) setOpen(true);
            else if (!touched) e.currentTarget.select();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(hits[cursor]);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      {open && hits.length ? (
        <ul id="repair-model-list" role="listbox" className="absolute z-20 left-0 right-0 mt-1 card p-1 max-h-[320px] overflow-y-auto">
          {hits.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === cursor}
              className={`px-3 py-2.5 rounded-[9px] cursor-pointer text-[14.5px] ${i === cursor ? "bg-[color:var(--surface-2)]" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="font-semibold">
                {m.brand} {m.model}
              </span>
              {m.releaseYear ? <span className="text-muted"> · {m.releaseYear}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {q.trim().length >= 2 && open && !hits.length && !error ? <p className="hint">No model matches “{q.trim()}”.</p> : null}
      <ErrorText error={error} />
    </div>
  );
}

function PartRow({ r, org, onSaved }: { r: RepairPriceView; org: string | undefined; onSaved: (rows: RepairPriceView[], msg: string) => void }) {
  const [price, setPrice] = useState(String(r.price));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = parseRupees(price);
  const dirty = n !== r.price;

  async function send(p: number | null, msg: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Res>("/api/admin/repair-book", { body: { orgId: org, modelId: r.modelId, part: r.part, price: p } });
      onSaved(res.rows, msg);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="font-semibold">{r.partLabel}</td>
      <td>
        <form
          className="flex gap-2 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty) return;
            if (n === null || n < 0) return setError("Whole rupees only.");
            void send(n, `${r.partLabel}: ${inr(r.price)} → ${inr(n)}.`);
          }}
        >
          <RupeeInput
            className="!min-h-[38px] !py-1.5 !w-[124px]"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label={`${r.partLabel} price`}
          />
          {dirty ? (
            <>
              <button className="btn btn-primary btn-sm" disabled={busy || n === null}>
                {busy ? "…" : "Save"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrice(String(r.price))} disabled={busy}>
                Undo
              </button>
            </>
          ) : null}
        </form>
        {error ? <div className="text-[12.5px] text-bad mt-1">{error}</div> : null}
      </td>
      <td className="max-w-[340px]">
        {r.source ? (
          <div className="space-y-0.5">
            <SourceBadge kind={r.source.kind === "client" ? "manual" : r.source.kind} label={r.source.label} />
            <div className="text-[12.5px] text-ink-2">
              {r.source.url ? (
                <a href={r.source.url} target="_blank" rel="noreferrer noopener">
                  {r.source.label} ↗
                </a>
              ) : (
                r.source.label
              )}
            </div>
            {r.source.observedAt ? <div className="hint !mt-0">Seen {fmtDay(r.source.observedAt)}</div> : null}
          </div>
        ) : (
          <span className="text-muted">Not recorded</span>
        )}
      </td>
      <td className="text-right">
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Remove the ${r.partLabel.toLowerCase()} price?`))
              void send(null, `Removed the ${r.partLabel.toLowerCase()} price.`);
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function AddPartForm({ org, modelId, have, onSaved }: { org: string | undefined; modelId: string; have: PartId[]; onSaved: (rows: RepairPriceView[], msg: string) => void }) {
  const missing = (Object.keys(PART_LABEL) as PartId[]).filter((p) => !have.includes(p));
  const [part, setPart] = useState<PartId | "">(missing[0] ?? "");
  const [price, setPrice] = useState("");
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = parseRupees(price);
  const partOk = part !== "" && missing.includes(part);

  if (!missing.length) return <p className="text-ink-2">Every part has a price for this model. Edit a price in the table above.</p>;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!partOk) return setError("Choose the part.");
        if (n === null || n < 0) return setError("Enter the list price in whole rupees.");
        setBusy(true);
        setError(null);
        try {
          const r = await api<Res>("/api/admin/repair-book", { body: { orgId: org, modelId, part, price: n, sourceLabel: src.trim() || undefined } });
          onSaved(r.rows, `Added ${PART_LABEL[part].toLowerCase()} at ${inr(n)}.`);
          setPrice("");
          setSrc("");
          setPart((Object.keys(PART_LABEL) as PartId[]).find((p) => p !== part && !have.includes(p)) ?? "");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Part">
          <select className="select" value={part} onChange={(e) => setPart(e.target.value as PartId)}>
            {missing.map((p) => (
              <option key={p} value={p}>
                {PART_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="List price, excl. GST (₹)">
          <input className="input num" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 4999" required />
        </Field>
        <Field label="Where is the price from?" hint="Shown next to the price.">
          <input className="input" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="Entered by programme admin" maxLength={120} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || !partOk || n === null}>
          {busy ? "Adding…" : "Add price"}
        </button>
        {n !== null && n > 0 ? (
          <span className="hint !mt-0">
            Customer would see <Money value={n} /> for the part, plus labour and GST.
          </span>
        ) : null}
      </div>
      <ErrorText error={error} />
    </form>
  );
}
