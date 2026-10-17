"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";
import { StepCard, ChipGroup } from "./StepCard";
import { COVER_LABEL } from "./shared";
import type { CaseOps, ModelOption } from "./ops";
import { Imei2Field } from "./Imei2Field";

const COVER_HINT: Record<keyof typeof COVER_LABEL, string> = {
  none: "The customer pays the full repair.",
  warranty: "Faults that are not physical or liquid damage are repaired free. Physical damage is charged.",
  care_plus: "Accidental damage is repaired for the plan's per-claim fee; other faults are free.",
};

/** ① Which phone: brand → model → storage, the IMEI, and any cover it has. */
export function StepPhone({ ops, brands, initialModel }: { ops: CaseOps; brands: string[]; initialModel: ModelOption | null }) {
  const { view, editable, save } = ops;
  const [model, setModel] = useState<ModelOption | null>(initialModel);
  const [brand, setBrand] = useState<string>(initialModel?.brand ?? view.device?.brand ?? (brands.includes("Samsung") ? "Samsung" : brands[0] ?? ""));
  const [picking, setPicking] = useState(!initialModel);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ModelOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [imei, setImei] = useState(view.imei ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [imeiErr, setImeiErr] = useState<string | null>(null);
  const reqId = useRef(0);

  // Keep the field in step with the server's reading (it completes a 14-digit IMEI).
  const savedImei = view.imei ?? "";
  const lastSaved = useRef(savedImei);
  useEffect(() => {
    if (savedImei !== lastSaved.current) {
      lastSaved.current = savedImei;
      setImei(savedImei);
    }
  }, [savedImei]);

  useEffect(() => {
    if (!picking || !editable) return;
    const my = ++reqId.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (brand) params.set("brand", brand);
        const r = await api<{ models: ModelOption[] }>(`/api/catalog/models?${params}`);
        if (my === reqId.current) setResults(r.models.slice(0, 18));
      } catch (e) {
        if (my === reqId.current) setErr((e as Error).message);
      } finally {
        if (my === reqId.current) setSearching(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, brand, picking, editable]);

  async function pick(m: ModelOption) {
    setModel(m);
    setPicking(false);
    setQ("");
    const e = await save(
      { modelId: m.id },
      {
        device: {
          modelId: m.id,
          brand: m.brand,
          model: m.model,
          series: m.series,
          variant: null,
          releaseYear: m.releaseYear,
          supportEndYear: m.supportEndYear,
          ageYears: m.releaseYear ? Math.max(0, new Date().getFullYear() - m.releaseYear) : null,
        },
      }
    );
    setErr(e);
  }

  async function pickVariant(v: string) {
    // The pressed chip again is no news: nothing to save (the server would keep the size's source anyway).
    if (!view.device || view.device.variant === v) return;
    setErr(await save({ variant: v }, { device: { ...view.device, variant: v } }));
  }

  const lastSent = useRef<string | null>(null);
  async function saveImei() {
    const d = imei.replace(/\D/g, "");
    if (d === (view.imei ?? "") || d === lastSent.current) return;
    if (!d) {
      setImeiErr(await save({ imei: null }, { imei: null, imeiCheck: null }));
      return;
    }
    if (d.length !== 14 && d.length !== 15) {
      setImeiErr(`An IMEI has 15 digits — this has ${d.length}.`);
      return;
    }
    lastSent.current = d;
    const e = await save({ imei: d });
    lastSent.current = null;
    setImeiErr(e);
  }

  async function pickCover(c: keyof typeof COVER_LABEL) {
    setErr(await save({ coverage: c }, { coverage: c }));
  }

  // Done = the phone is priceable (model + storage). The IMEI is only needed to take the trade-in — step 7 asks for it.
  const done = !!view.device?.variant;
  const variants = model && view.device && model.id === view.device.modelId ? model.variants : [];

  return (
    <StepCard n={1} id="step-phone" title="The phone" done={done}>
      <div className="space-y-5">
        {/* Model */}
        {view.device && !picking ? (
          <div className="flex flex-wrap items-center gap-3 justify-between rounded-[12px] border border-line bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[18px] font-[720] leading-tight">
                {view.device.brand} {view.device.model}
              </div>
              <div className="text-[13px] text-muted">
                {view.device.releaseYear ? `Launched ${view.device.releaseYear}` : "Launch year not recorded"}
                {view.device.supportEndYear ? ` · security updates until ${view.device.supportEndYear}` : ""}
              </div>
            </div>
            {editable ? (
              <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
                Change model
              </button>
            ) : null}
          </div>
        ) : editable ? (
          <div className="space-y-3">
            <ChipGroup label="Brand">
              {brands.map((b) => (
                <button key={b} type="button" className="chip" aria-pressed={brand === b} onClick={() => setBrand(b)}>
                  {b}
                </button>
              ))}
            </ChipGroup>
            <label className="block">
              <span className="label">Model</span>
              <input
                className="input"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${brand || "all"} models, e.g. ${brand === "Apple" ? "iPhone 13" : "S22"}`}
                autoComplete="off"
                aria-controls="model-results"
              />
            </label>
            <div id="model-results" className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-live="polite" aria-busy={searching}>
              {results.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pick(m)}
                  className="text-left rounded-[11px] border-[1.5px] border-[color:var(--line-2)] bg-surface px-3.5 py-2.5 hover:border-[color:var(--ink)]"
                >
                  <span className="block text-[15px] font-semibold">
                    {m.brand === brand ? "" : `${m.brand} `}
                    {m.model}
                  </span>
                  <span className="block text-[12.5px] text-muted">
                    {m.releaseYear ?? "—"} · {m.variants.join(" / ")}
                  </span>
                </button>
              ))}
            </div>
            {!searching && results.length === 0 ? (
              <div className="hint">{`No ${brand} model matches “${q}”. Try fewer letters, or another brand.`}</div>
            ) : null}
            {view.device ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(false)}>
                Keep {view.device.model}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="text-muted">No phone recorded.</div>
        )}

        {/* Storage */}
        {view.device && !picking ? (
          <ChipGroup
            label="Storage"
            hint={!view.device.variant ? "Settings → About phone → Storage, or the box label." : view.variantSource === "customer" ? (view.offer?.storage.note ?? undefined) : undefined}
          >
            {variants.length ? (
              variants.map((v) => (
                <button key={v} type="button" className="chip" aria-pressed={view.device?.variant === v} disabled={!editable} onClick={() => pickVariant(v)}>
                  {v}
                </button>
              ))
            ) : view.device.variant ? (
              <span className="chip on" aria-pressed>
                {view.device.variant}
              </span>
            ) : (
              <span className="hint">—</span>
            )}
          </ChipGroup>
        ) : null}

        {/* IMEI */}
        <div>
          <label className="block">
            <span className="label">IMEI</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input num max-w-[260px]"
                value={imei}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d\s]/g, "");
                  setImei(v);
                  setImeiErr(null);
                }}
                onBlur={saveImei}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveImei();
                  }
                }}
                inputMode="numeric"
                autoComplete="off"
                placeholder="15 digits"
                maxLength={18}
                disabled={!editable}
                aria-invalid={!!imeiErr || view.imeiCheck === "invalid" || undefined}
              />
              {view.imei && view.imeiCheck === "valid" && imei.replace(/\D/g, "") === view.imei ? <span className="pill pill-up">✓ Check digit OK</span> : null}
              {view.imeiCheck === "invalid" ? <span className="pill pill-warn">⚠ Check digit fails — re-read it</span> : null}
            </div>
          </label>
          {imeiErr ? (
            <span className="hint" style={{ color: "var(--bad)" }}>
              {imeiErr}
            </span>
          ) : (
            <span className="hint">Dial *#06# on the phone, or scan the barcode on the box. 14 digits are completed automatically.</span>
          )}
        </div>

        <Imei2Field ops={ops} />

        {/* Cover */}
        <ChipGroup label="Cover" hint={COVER_HINT[view.coverage]}>
          {(Object.keys(COVER_LABEL) as (keyof typeof COVER_LABEL)[]).map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={view.coverage === c} disabled={!editable} onClick={() => pickCover(c)}>
              {COVER_LABEL[c]}
            </button>
          ))}
        </ChipGroup>
      </div>
      <ErrorText error={err} />
    </StepCard>
  );
}
