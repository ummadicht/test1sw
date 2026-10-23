"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";
import { StepCard, ChipGroup } from "./StepCard";
import { phoneLine } from "./caseSteps";
import { COVER_LABEL } from "./shared";
import type { CaseOps, ModelOption } from "./ops";
import { Imei2Field } from "./Imei2Field";
import { ImeiResult, ReadTheScreen } from "./ImeiCapture";
import { imeiPatch } from "./imeiFirst";

const COVER_HINT: Record<keyof typeof COVER_LABEL, string> = {
  none: "Customer pays the full repair.",
  warranty: "Free, except physical or liquid damage.",
  care_plus: "Damage at the claim fee; other faults free.",
};

/**
 * PHONE — which phone: the IMEI first (typed, or "Read the screen"; SUP-35), with what the server
 * found for it before any test (the model, GSMA's word, an IMEI already traded in), then brand →
 * model → storage, and any cover it has. One line says what is on file.
 */
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

  // The model can arrive from elsewhere — the IMEI names it on save, or a test does: fetch its
  // sizes so the storage chips show, and close the picker.
  const deviceId = view.device?.modelId ?? null;
  const deviceName = view.device ? `${view.device.brand}|${view.device.model}` : null;
  useEffect(() => {
    if (!deviceId || !deviceName || model?.id === deviceId) return;
    let live = true;
    const [b, m] = deviceName.split("|");
    api<{ models: ModelOption[] }>(`/api/catalog/models?${new URLSearchParams({ q: m, brand: b })}`)
      .then((r) => {
        const found = r.models.find((x) => x.id === deviceId);
        if (!live || !found) return;
        setModel(found);
        setBrand(found.brand);
        setPicking(false);
      })
      .catch(() => {
        /* the chips come with the next load */
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the case's model changes
  }, [deviceId, deviceName]);

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
      setImeiErr("An IMEI has 15 digits.");
      return;
    }
    lastSent.current = d;
    const e = await save({ imei: d });
    lastSent.current = null;
    setImeiErr(e);
  }

  /** A read of the *#06# screen, confirmed: IMEI 1 (and IMEI 2) saved with the store app's PATCH. */
  async function saveRead(v: { imei: string; imei2: string | null }) {
    setImei(v.imei);
    setImeiErr(null);
    setImeiErr(await save(imeiPatch(v, view.imei)));
  }

  async function pickCover(c: keyof typeof COVER_LABEL) {
    setErr(await save({ coverage: c }, { coverage: c }));
  }

  const variants = model && view.device && model.id === view.device.modelId ? model.variants : [];

  // Everything but the four answers waits behind "Show details": the launch year, the second IMEI, the hints.
  const details = (
    <>
      {view.device ? (
        <p className="text-[14px] text-ink-2">
          {view.device.brand} {view.device.model} · {view.device.releaseYear ? `launched ${view.device.releaseYear}` : "launch year not recorded"}
          {view.device.supportEndYear ? ` · security updates until ${view.device.supportEndYear}` : ""}
        </p>
      ) : null}
      {view.device && view.variantSource === "customer" && view.offer?.storage.note ? <p className="text-[14px] text-warn font-semibold">{view.offer.storage.note}</p> : null}
      <p className="hint !mt-0">Storage: Settings › About phone. IMEI: dial *#06#.</p>
      <Imei2Field ops={ops} />
      <p className="hint !mt-0">Cover: {COVER_HINT[view.coverage]}</p>
    </>
  );

  return (
    <StepCard id="step-phone" title="Which phone is it?" line={phoneLine(view)} details={details}>
      {/* IMEI — first: what the server finds for it shows here, before any test */}
      <div className="space-y-2">
        <label className="block" htmlFor="step-phone-imei">
          <span className="label">IMEI</span>
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="step-phone-imei"
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
          {editable ? (
            <ReadTheScreen
              onConfirm={saveRead}
              onMisread={(d) => {
                setImei(d);
                setImeiErr(null);
              }}
            />
          ) : null}
          {view.imeiCheck === "invalid" ? <span className="pill pill-warn self-center">⚠ Re-read the IMEI</span> : null}
        </div>
        {imeiErr ? (
          <span className="hint" style={{ color: "var(--bad)" }}>
            {imeiErr}
          </span>
        ) : null}
        <ImeiResult view={view} />
      </div>

      {/* Model */}
      {view.device && !picking ? (
        <div className="flex flex-wrap items-center gap-3 justify-between rounded-[12px] border border-line bg-surface-2 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[18px] font-[720] leading-tight">
              {view.device.brand} {view.device.model}
            </div>
            {view.modelSource === "imei" ? <div className="text-[13px] text-muted">From the IMEI</div> : null}
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
            <div className="hint">{`No ${brand} model matches “${q}”.`}</div>
          ) : null}
          {view.device ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(false)}>
              Keep {view.device.model}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="text-muted">No phone yet.</div>
      )}

      {/* Storage */}
      {view.device && !picking ? (
        <ChipGroup label="Storage">
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

      {/* Cover */}
      <ChipGroup label="Cover">
        {(Object.keys(COVER_LABEL) as (keyof typeof COVER_LABEL)[]).map((c) => (
          <button key={c} type="button" className="chip" aria-pressed={view.coverage === c} disabled={!editable} onClick={() => pickCover(c)}>
            {COVER_LABEL[c]}
          </button>
        ))}
      </ChipGroup>
      <ErrorText error={err} />
    </StepCard>
  );
}
