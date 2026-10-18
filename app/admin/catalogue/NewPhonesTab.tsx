"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Field, SourceBadge } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type { NewDeviceView } from "@/lib/server/catalog";
import { SERIES, SERIES_LABEL, fmtDay, parseRupees } from "@/components/admin/format";
import { RupeeInput } from "@/components/admin/RupeeInput";

type Res = { devices: NewDeviceView[] };

/** NEW PHONES — what the counter can sell as the upgrade, at what price. */
export function NewPhonesTab({ orgId, isPlatform, initial }: { orgId: string; isPlatform: boolean; initial: NewDeviceView[] }) {
  const [devices, setDevices] = useState(initial);
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const org = isPlatform ? orgId : undefined;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? devices.filter((d) => `${d.brand} ${d.model} ${d.variant} ${d.series}`.toLowerCase().includes(t)) : devices;
  }, [devices, q]);
  const activeCount = devices.filter((d) => d.active).length;

  return (
    <div className="space-y-5">
      {notice ? <Banner tone="up">{notice}</Banner> : null}
      <Card
        title={`${activeCount} of ${devices.length} phones offered at the counter`}
        action={
          <input className="input !min-h-[38px] !py-1.5 max-w-[240px]" placeholder="Search model or variant" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search new phones" />
        }
        pad={false}
      >
        {shown.length ? (
          <div className="overflow-x-auto">
            <table className="table min-w-[980px]">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Variant</th>
                  <th className="w-[230px]">Price</th>
                  <th>Updates until</th>
                  <th>At the counter</th>
                  <th>Price source</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <PhoneRow
                    key={d.id}
                    d={d}
                    org={org}
                    onSaved={(list, msg) => {
                      setDevices(list);
                      setNotice(msg);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={devices.length ? "No phone matches that search" : "No new phones yet"}>{devices.length ? null : "Add the first one below."}</Empty>
        )}
      </Card>
      <p className="hint">Price changes are logged with your source.</p>

      <Card title="Add a phone">
        <AddPhoneForm
          org={org}
          onSaved={(list, msg) => {
            setDevices(list);
            setNotice(msg);
          }}
        />
      </Card>
    </div>
  );
}

function PhoneRow({ d, org, onSaved }: { d: NewDeviceView; org: string | undefined; onSaved: (list: NewDeviceView[], msg: string) => void }) {
  const [price, setPrice] = useState(String(d.price));
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = parseRupees(price);
  const dirty = n !== d.price;

  async function savePrice() {
    if (n === null || n <= 0) return setError("Enter a whole rupee price.");
    setBusy(true);
    setError(null);
    try {
      const r = await api<Res>("/api/admin/new-devices", {
        body: {
          orgId: org,
          id: d.id,
          brand: d.brand,
          model: d.model,
          series: d.series,
          variant: d.variant,
          price: n,
          supportEndYear: d.supportEndYear,
          active: d.active,
          sourceLabel: src.trim() || undefined,
        },
      });
      setSrc("");
      onSaved(r.devices, `${d.model} ${d.variant} now ${inr(n)}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Res>(`/api/admin/new-devices/${encodeURIComponent(d.id)}/active`, { body: { orgId: org, active: !d.active } });
      onSaved(r.devices, d.active ? `${d.model} ${d.variant} is hidden from the counter.` : `${d.model} ${d.variant} is back on the counter.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={d.active ? "" : "opacity-60"}>
      <td>
        <div className="font-semibold">{d.model}</div>
        <div className="hint !mt-0.5">
          {d.brand} · {SERIES_LABEL[d.series] ?? `${d.series} series`}
        </div>
      </td>
      <td>{d.variant}</td>
      <td>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void savePrice();
          }}
        >
          <div className="flex gap-2 items-center">
            <RupeeInput
              className="!min-h-[38px] !py-1.5 !w-[124px]"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-label={`Price of ${d.model} ${d.variant}`}
            />
            {dirty ? (
              <>
                <button className="btn btn-primary btn-sm" disabled={busy || n === null}>
                  {busy ? "…" : "Save"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrice(String(d.price))} disabled={busy}>
                  Undo
                </button>
              </>
            ) : null}
          </div>
          {dirty ? (
            <input
              className="input !min-h-[34px] !py-1 !text-[13px]"
              placeholder="Where is this price from? (optional)"
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              maxLength={120}
            />
          ) : null}
          {error ? <div className="text-[12.5px] text-bad">{error}</div> : null}
        </form>
      </td>
      <td className="num">{d.supportEndYear ?? "—"}</td>
      <td>
        <button type="button" className={`btn btn-sm ${d.active ? "" : "btn-up"}`} onClick={toggle} disabled={busy} aria-pressed={d.active}>
          {d.active ? "Offered · hide" : "Hidden · offer"}
        </button>
      </td>
      <td className="max-w-[260px]">
        {d.source ? (
          <div className="space-y-0.5">
            <SourceBadge kind={d.source.kind === "client" ? "manual" : d.source.kind} label={d.source.label} />
            <div className="text-[12.5px] text-ink-2">
              {d.source.url ? (
                <a href={d.source.url} target="_blank" rel="noreferrer noopener">
                  {d.source.label} ↗
                </a>
              ) : (
                d.source.label
              )}
            </div>
            {d.source.observedAt ? <div className="hint !mt-0">Seen {fmtDay(d.source.observedAt)}</div> : null}
          </div>
        ) : (
          <span className="text-muted">Not recorded</span>
        )}
      </td>
    </tr>
  );
}

const BLANK = { model: "", series: "S", variant: "", price: "", sey: "", src: "" };

function AddPhoneForm({ org, onSaved }: { org: string | undefined; onSaved: (list: NewDeviceView[], msg: string) => void }) {
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const price = parseRupees(f.price);
  const sey = f.sey.trim() ? Number(f.sey) : null;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (price === null || price <= 0) return setError("Enter the selling price in whole rupees.");
        if (sey !== null && (!Number.isInteger(sey) || sey < 2020 || sey > 2045)) return setError("Security updates end year should be a year like 2032.");
        setBusy(true);
        try {
          const r = await api<Res>("/api/admin/new-devices", {
            body: {
              orgId: org,
              brand: "Samsung",
              model: f.model.trim(),
              series: f.series,
              variant: f.variant.trim(),
              price,
              supportEndYear: sey,
              active: true,
              sourceLabel: f.src.trim() || undefined,
            },
          });
          onSaved(r.devices, `Added ${f.model.trim()} ${f.variant.trim()} at ${inr(price)}.`);
          setF(BLANK);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Field label="Model">
          <input className="input" value={f.model} onChange={set("model")} placeholder="e.g. Galaxy S25 FE" required minLength={2} maxLength={60} />
        </Field>
        <Field label="Series">
          <select className="select" value={f.series} onChange={set("series")}>
            {SERIES.map((s) => (
              <option key={s} value={s}>
                {SERIES_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Variant">
          <input className="input" value={f.variant} onChange={set("variant")} placeholder="e.g. 8GB / 256GB" required minLength={2} maxLength={40} />
        </Field>
        <Field label="Selling price (₹)">
          <input className="input num" inputMode="numeric" value={f.price} onChange={set("price")} placeholder="e.g. 59999" required />
        </Field>
        <Field label="Security updates until (year)" hint="From Samsung's security-update page. Optional.">
          <input className="input num" inputMode="numeric" value={f.sey} onChange={set("sey")} placeholder="e.g. 2032" maxLength={4} />
        </Field>
        <Field label="Where is the price from?" hint="Shown next to the price, e.g. “samsung.com/in, 15 Oct”.">
          <input className="input" value={f.src} onChange={set("src")} placeholder="Entered by programme admin" maxLength={120} />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy || f.model.trim().length < 2 || f.variant.trim().length < 2 || price === null}>
        {busy ? "Adding…" : "Add phone"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

