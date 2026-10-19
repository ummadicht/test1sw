"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Field, Money, fmtDate } from "@/components/ui";
import { fmtBp, bpToPct, pctToBp } from "@/lib/domain/money";
import { SCREEN_ORDER, BODY_ORDER, SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL, type IssueId, type AgeBand } from "@/lib/domain/condition";
import { gradePricesProblem, type GradePrices, type RateCard } from "@/lib/domain/ratecard";
import type { RateCardSummary } from "@/lib/server/catalog";
import type { PartnerMode } from "@/lib/server/buyback";

type Deductions = RateCard["deductions"];

export type ActiveCardInfo = {
  id: string;
  label: string;
  kind: "partner_ratecard";
  note: string | null;
  effectiveFrom: string;
  quoteValidityDays: number;
  entries: number;
  roundTo: number;
  maxDeductionBp: number;
  floorBp: number;
  deductions: Deductions;
  createdAt: string;
};

type Props = {
  /** Set for platform staff (sent as ?partnerId=); null for the partner's own team. */
  partnerId: string | null;
  partnerName: string;
  mode: PartnerMode;
  cards: RateCardSummary[];
  active: ActiveCardInfo | null;
  /** SwapUp's own % per defect (the table every PriceIQ trade-in uses) — offered as a starting point only. */
  swapupDeductions: Deductions;
};

/* ── deductions: one row per thing the card takes money off for ── */

const ISSUE_IDS = Object.keys(ISSUE_LABEL) as IssueId[];
const AGE_BANDS = Object.keys(AGE_LABEL) as AgeBand[];

type DedRow = { path: string; label: string };
const DED_GROUPS: { title: string; note?: string; rows: DedRow[] }[] = [
  {
    title: "Switching on and calls",
    note: "A dead phone is priced on this line alone (plus accessories and age).",
    rows: [
      { path: "deadBp", label: "Does not switch on" },
      { path: "callsBp", label: "Calls / network not working" },
    ],
  },
  { title: "Screen", rows: SCREEN_ORDER.map((s) => ({ path: `screen.${s}`, label: SCREEN_LABEL[s] })) },
  { title: "Body", rows: BODY_ORDER.map((b) => ({ path: `body.${b}`, label: BODY_LABEL[b] })) },
  { title: "Functional issues", rows: ISSUE_IDS.map((i) => ({ path: `issues.${i}`, label: ISSUE_LABEL[i] })) },
  {
    title: "Accessories missing",
    rows: [
      { path: "noChargerBp", label: "No original charger" },
      { path: "noBoxBp", label: "No original box" },
      { path: "noBillBp", label: "No purchase bill" },
    ],
  },
  { title: "Age", rows: AGE_BANDS.map((a) => ({ path: `age.${a}`, label: AGE_LABEL[a] })) },
];
const ALL_PATHS = DED_GROUPS.flatMap((g) => g.rows.map((r) => r.path));

function bpAt(d: Deductions, path: string): number {
  const [a, b] = path.split(".");
  const v = b ? (d as unknown as Record<string, Record<string, number>>)[a]?.[b] : (d as unknown as Record<string, number>)[a];
  return typeof v === "number" ? v : 0;
}

function toPercentStrings(d: Deductions | null): Record<string, string> {
  return Object.fromEntries(ALL_PATHS.map((p) => [p, d ? String(bpToPct(bpAt(d, p))) : ""]));
}

function fromPercentStrings(v: Record<string, string>): { deductions: Deductions | null; error: string | null } {
  const bp: Record<string, number> = {};
  for (const g of DED_GROUPS) {
    for (const r of g.rows) {
      const raw = (v[r.path] ?? "").trim();
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || n < 0 || n > 100) return { deductions: null, error: `${g.title} — “${r.label}”: enter a percentage from 0 to 100.` };
      bp[r.path] = pctToBp(n);
    }
  }
  const pick = <K extends string>(prefix: string, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, bp[`${prefix}.${k}`]])) as Record<K, number>;
  return {
    error: null,
    deductions: {
      deadBp: bp.deadBp,
      callsBp: bp.callsBp,
      screen: pick("screen", SCREEN_ORDER),
      body: pick("body", BODY_ORDER),
      issues: pick("issues", ISSUE_IDS),
      noChargerBp: bp.noChargerBp,
      noBoxBp: bp.noBoxBp,
      noBillBp: bp.noBillBp,
      age: pick("age", AGE_BANDS),
    },
  };
}

/* ── CSV check: mirrors the server's reading of the sheet line for line ── */

type CsvCheck = { priced: number; blankLines: number[]; problems: string[] };

function checkCsv(csv: string, known: Map<string, string[]> | null): CsvCheck {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: CsvCheck = { priced: 0, blankLines: [], problems: [] };
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const [modelId = "", variant = "", priceRaw, ...gradeRaw] = line.split(",").map((x) => (x ?? "").trim());
    if (i === 0 && /model/i.test(modelId)) return; // header
    const n = i + 1;
    if (known && !known.has(modelId)) return void out.problems.push(`Line ${n}: unknown model id “${modelId}”.`);
    if (known && !known.get(modelId)!.includes(variant)) return void out.problems.push(`Line ${n}: “${variant}” is not a storage option of ${modelId}.`);
    const cleaned = String(priceRaw ?? "").replace(/[₹\s]/g, "");
    if (cleaned === "") return void out.blankLines.push(n);
    const price = Number(cleaned);
    if (!Number.isInteger(price) || price <= 0) return void out.problems.push(`Line ${n}: price must be a whole rupee amount (no commas or paise).`);
    const key = `${modelId}|${variant}`;
    if (seen.has(key)) return void out.problems.push(`Line ${n}: ${modelId} ${variant} appears twice.`);
    // The optional grade columns, checked the server's way (ratecard.ts gradePricesProblem).
    const gradePrices: GradePrices = {};
    (["Good", "Fair", "Best Value"] as const).forEach((g, j) => {
      const raw = String(gradeRaw[j] ?? "").replace(/[₹\s]/g, "");
      if (raw !== "") gradePrices[g] = Number(raw);
    });
    const bad = gradePricesProblem({ modelId, variant, maxPrice: price, gradePrices });
    if (bad) return void out.problems.push(`Line ${n}: ${bad}.`);
    seen.add(key);
    out.priced += 1;
  });
  return out;
}

function normaliseCsv(csv: string): string {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function dropUnpricedRows(csv: string): string {
  const lines = normaliseCsv(csv).split("\n");
  return lines
    .filter((line, i) => {
      const [modelId = "", , priceRaw] = line.split(",").map((x) => (x ?? "").trim());
      if (i === 0 && /model/i.test(modelId)) return true;
      return String(priceRaw ?? "").replace(/[₹\s]/g, "") !== "";
    })
    .join("\n");
}

function localToday(): string {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the browser's own timezone
}

function KindPill(_: { kind: string }) {
  return <span className="pill pill-fix">Partner rate card</span>;
}

/* ── the page ─────────────────────────────────────────────── */

export function RateCards({ partnerId, partnerName, mode, cards, active, swapupDeductions }: Props) {
  const router = useRouter();
  const qs = partnerId ? `?partnerId=${encodeURIComponent(partnerId)}` : "";
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const uploadedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (uploaded) uploadedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [uploaded]);

  async function activate(id: string) {
    setBusyId(id);
    setHistoryError(null);
    try {
      await api(`/api/partner/rate-cards/${encodeURIComponent(id)}${qs}`, { body: { action: "activate", partnerId: partnerId ?? undefined } });
      setConfirmId(null);
      router.refresh();
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <div className="section-title">{partnerName}</div>
        <h1 className="text-[26px] sm:text-[28px] font-[750] tracking-tight leading-tight mt-1">Rate cards</h1>
        <p className="text-ink-2 mt-1.5 max-w-[72ch] text-[15px] leading-relaxed">The sheet the counter prices trade-ins from.</p>
      </header>

      <ModeBanner mode={mode} />

      <ActiveCard active={active} onView={() => active && setOpenId(active.id)} />

      {uploaded ? (
        <div ref={uploadedRef} className="banner banner-up" role="status">
          <span aria-hidden>✓</span>
          <div className="flex-1">{uploaded}</div>
          <button className="btn btn-sm btn-ghost !min-h-0 !py-0" onClick={() => setUploaded(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      {/* Re-mounts when the active card changes, so the deductions section starts from the new card. */}
      <UploadForm
        key={`upload-${active?.id ?? "none"}`}
        partnerId={partnerId}
        qs={qs}
        active={active}
        swapupDeductions={swapupDeductions}
        onUploaded={(msg) => {
          setUploaded(msg);
          router.refresh();
        }}
      />

      <Card title="All rate cards" pad={false}>
        {historyError ? (
          <div className="px-5">
            <ErrorText error={historyError} />
          </div>
        ) : null}
        {cards.length === 0 ? (
          <Empty title="No rate cards yet">Upload the first one above.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[760px]">
              <thead>
                <tr>
                  <th>Card</th>
                  <th>Effective from</th>
                  <th className="text-right">Prices</th>
                  <th className="text-right">Quote valid</th>
                  <th>Uploaded</th>
                  <th className="text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id}>
                    <td className="min-w-[240px]">
                      <div className="font-semibold">{c.label || "Untitled card"}</div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <KindPill kind={c.kind} />
                        {c.active ? <span className="pill pill-up">● Active</span> : null}
                      </div>
                    </td>
                    <td className="num whitespace-nowrap">{c.effectiveFrom || "—"}</td>
                    <td className="num text-right">{c.entries}</td>
                    <td className="num text-right whitespace-nowrap">
                      {c.quoteValidityDays} {c.quoteValidityDays === 1 ? "day" : "days"}
                    </td>
                    <td className="whitespace-nowrap text-[13.5px]">{fmtDate(c.createdAt)}</td>
                    <td className="text-right">
                      {confirmId === c.id ? (
                        <div className="inline-flex flex-col items-end gap-2 max-w-[360px] text-left">
                          <span className="text-[13px] text-ink-2">
                            New quotes use it at once; old quotes keep their price.
                          </span>
                          <span className="inline-flex gap-2">
                            <button className="btn btn-sm btn-primary" disabled={busyId === c.id} onClick={() => activate(c.id)}>
                              {busyId === c.id ? "Switching…" : "Make active"}
                            </button>
                            <button className="btn btn-sm btn-ghost" disabled={busyId === c.id} onClick={() => setConfirmId(null)}>
                              Cancel
                            </button>
                          </span>
                        </div>
                      ) : (
                        <span className="inline-flex gap-2 whitespace-nowrap">
                          <button className="btn btn-sm" onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
                            {openId === c.id ? "Hide prices" : "View prices"}
                          </button>
                          {c.active ? null : (
                            <button className="btn btn-sm" onClick={() => setConfirmId(c.id)}>
                              Make active
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId ? <CardDetail key={`detail-${openId}`} id={openId} qs={qs} onClose={() => setOpenId(null)} /> : null}

      <HowItWorks active={active} />
    </div>
  );
}

/* ── which pricing source is in force ─────────────────────── */

function ModeBanner({ mode }: { mode: PartnerMode }) {
  if (mode.kind === "partner_ratecard")
    return (
      <Banner tone="up">
        <strong>Prices PriceIQ can&apos;t: {mode.label}.</strong> {mode.why}
      </Banner>
    );
  return (
    <Banner>
      <strong>No rate card.</strong> PriceIQ prices each phone; where it has no price, staff enter the partner&apos;s quote.
    </Banner>
  );
}

/* ── active card summary ──────────────────────────────────── */

function ActiveCard({ active, onView }: { active: ActiveCardInfo | null; onView: () => void }) {
  if (!active)
    return (
      <Card title="Active card">
        <p className="text-ink-2">No card is active.</p>
      </Card>
    );
  return (
    <Card
      title="Active card"
      action={
        <button className="btn btn-sm" onClick={onView}>
          View prices
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[19px] font-[750] tracking-tight leading-snug">{active.label}</h2>
        <KindPill kind={active.kind} />
      </div>
      {active.note ? <p className="hint">{active.note}</p> : null}
      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <dt className="section-title">Effective from</dt>
          <dd className="m-0 mt-1 num text-[17px] font-semibold">{active.effectiveFrom || "—"}</dd>
        </div>
        <div>
          <dt className="section-title">Quote valid for</dt>
          <dd className="m-0 mt-1 num text-[17px] font-semibold">
            {active.quoteValidityDays} {active.quoteValidityDays === 1 ? "day" : "days"}
          </dd>
        </div>
        <div>
          <dt className="section-title">Phones priced</dt>
          <dd className="m-0 mt-1 num text-[17px] font-semibold">{active.entries}</dd>
          <dd className="hint m-0">model × storage rows</dd>
        </div>
        <div>
          <dt className="section-title">Uploaded</dt>
          <dd className="m-0 mt-1 text-[15px] font-semibold">{fmtDate(active.createdAt)}</dd>
        </div>
      </dl>
    </Card>
  );
}

/* ── upload ───────────────────────────────────────────────── */

function UploadForm({
  partnerId,
  qs,
  active,
  swapupDeductions,
  onUploaded,
}: {
  partnerId: string | null;
  qs: string;
  active: ActiveCardInfo | null;
  swapupDeductions: Deductions;
  onUploaded: (message: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [validity, setValidity] = useState(active ? String(active.quoteValidityDays) : "");
  const [csv, setCsv] = useState("");
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState<Map<string, string[]> | null>(null);
  const [catalogueError, setCatalogueError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Deductions: keep the active partner card's, or edit. With no card the partner gives its own (SwapUp's may be a start).
  const ownActive = active?.kind === "partner_ratecard";
  const [dedMode, setDedMode] = useState<"keep" | "edit">(ownActive ? "keep" : "edit");
  const [ded, setDed] = useState<Record<string, string>>(() => toPercentStrings(active ? active.deductions : null));
  const [dedFromSwapup, setDedFromSwapup] = useState(false);
  const [dedConfirmed, setDedConfirmed] = useState(false);

  useEffect(() => {
    setEffectiveFrom((v) => v || localToday());
  }, []);

  // The catalogue, so the sheet can be checked line by line before it is sent.
  useEffect(() => {
    if (!csv.trim() || known || catalogueError) return;
    let live = true;
    api<{ models: { id: string; variants: string[] }[] }>("/api/catalog/models")
      .then((r) => live && setKnown(new Map(r.models.map((m) => [m.id, m.variants]))))
      .catch(() => live && setCatalogueError(true));
    return () => {
      live = false;
    };
  }, [csv, known, catalogueError]);

  const check = useMemo(() => (csv.trim() ? checkCsv(csv, known) : null), [csv, known]);
  const blocked = !!check && (check.problems.length > 0 || check.blankLines.length > 0 || check.priced === 0);

  return (
    <Card title="Upload a new rate card">
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          let deductions: Deductions | undefined;
          if (dedMode === "edit") {
            const r = fromPercentStrings(ded);
            if (r.error) return setError(r.error);
            if (dedFromSwapup && !dedConfirmed) return setError("Confirm the condition deductions are your own before uploading.");
            deductions = r.deductions!;
          }
          const clean = normaliseCsv(csv);
          setCsv(clean); // the server numbers non-empty lines; now the box does too
          setBusy(true);
          try {
            const r = await api<{ cards: RateCardSummary[] }>(`/api/partner/rate-cards${qs}`, {
              body: { partnerId: partnerId ?? undefined, label: label.trim(), effectiveFrom, quoteValidityDays: Number(validity), csv: clean, activate, deductions },
            });
            const added = r.cards[0];
            const count = added?.entries ?? check?.priced ?? 0;
            onUploaded(
              `Uploaded “${added?.label ?? label.trim()}” with ${count} ${count === 1 ? "price" : "prices"} — ${
                activate ? "now active." : "saved, not active."
              }`
            );
            setLabel("");
            setCsv("");
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Card name">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required minLength={3} maxLength={120} placeholder="e.g. Retail sheet — week 42" />
          </Field>
          <Field label="Effective from">
            <input className="input num" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
          </Field>
          <Field label="Quote valid for (days)" hint="1 to 30.">
            <input className="input num" type="number" inputMode="numeric" min={1} max={30} step={1} value={validity} onChange={(e) => setValidity(e.target.value)} required />
          </Field>
        </div>

        <div>
          <div className="flex flex-wrap items-end justify-between gap-2 mb-1.5">
            <span className="label !mb-0">Prices (CSV: model_id, variant, max_price, good_price, fair_price, best_value_price — the last three optional)</span>
            <span className="flex flex-wrap gap-2">
              <a className="btn btn-sm no-underline" href={`/api/partner/rate-cards/template${qs}`} download>
                Download template
              </a>
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                Load a .csv file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setCsv(normaliseCsv(await f.text()));
                  e.target.value = "";
                }}
              />
            </span>
          </div>
          <textarea
            className="textarea num !text-[14px] !min-h-[180px]"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            spellCheck={false}
            placeholder={"model_id,variant,max_price,good_price,fair_price,best_value_price\ngalaxy-s22,128GB,12345,11870,11410,10860"}
            aria-describedby="csv-help"
          />
          <p id="csv-help" className="hint">
            Model id, storage, best-condition (grade A) price in whole rupees — e.g. <code className="num">galaxy-s22,128GB,12345</code> — then, if the sheet has them, the grade B, C and D prices.
          </p>
          {check ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[14px]">
                <span className="pill pill-up num">{check.priced} priced</span>
                {check.blankLines.length ? <span className="pill pill-warn num">{check.blankLines.length} without a price</span> : null}
                {check.problems.length ? <span className="pill pill-bad num">{check.problems.length} to fix</span> : null}
                {!known && !catalogueError ? <span className="hint !mt-0">Checking against the catalogue…</span> : null}
                {catalogueError ? <span className="hint !mt-0">Catalogue not loaded — the upload still checks.</span> : null}
              </div>
              {check.blankLines.length ? (
                <div className="banner banner-warn">
                  <span aria-hidden>⚠</span>
                  <div>
                    {check.blankLines.length} {check.blankLines.length === 1 ? "row has" : "rows have"} no price (line
                    {check.blankLines.length === 1 ? "" : "s"} {check.blankLines.slice(0, 8).join(", ")}
                    {check.blankLines.length > 8 ? "…" : ""}). Fill them in or remove them.
                    <div className="mt-2">
                      <button type="button" className="btn btn-sm" onClick={() => setCsv(dropUnpricedRows(csv))}>
                        Remove rows without a price
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {check.problems.length ? (
                <div className="banner banner-bad" role="alert">
                  <span aria-hidden>⛔</span>
                  <div className="min-w-0">
                    <ul className="list-none m-0 p-0 space-y-0.5">
                      {check.problems.slice(0, 20).map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                    {check.problems.length > 20 ? <div className="mt-1">…and {check.problems.length - 20} more.</div> : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <fieldset className="border-t border-line pt-4">
          <legend className="section-title pr-2">Condition deductions</legend>
          {dedMode === "keep" && active ? (
            <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
              <p className="text-[14px] text-ink-2 m-0">
                Same as the active card, <strong>{active.label}</strong>.
              </p>
              <button type="button" className="btn btn-sm" onClick={() => setDedMode("edit")}>
                Change deductions
              </button>
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              {!active ? (
                <Banner>Enter your % off the best price for each problem.</Banner>
              ) : null}
              {dedFromSwapup ? <Banner tone="warn">These are SwapUp&apos;s percentages — check each one is yours.</Banner> : null}
              <DeductionEditor values={ded} onChange={setDed} />
              <div className="flex flex-wrap items-center gap-3">
                {!active ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setDed(toPercentStrings(swapupDeductions));
                      setDedFromSwapup(true);
                      setDedConfirmed(false);
                    }}
                  >
                    Start from SwapUp&apos;s percentages
                  </button>
                ) : null}
                {ownActive ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setDed(toPercentStrings(active!.deductions));
                      setDedMode("keep");
                    }}
                  >
                    Keep the active card&apos;s deductions instead
                  </button>
                ) : null}
              </div>
              {dedFromSwapup ? (
                <label className="flex items-start gap-3 text-[14px] cursor-pointer">
                  <input type="checkbox" className="mt-1 h-5 w-5" checked={dedConfirmed} onChange={(e) => setDedConfirmed(e.target.checked)} />
                  <span>These are our own deductions.</span>
                </label>
              ) : null}
            </div>
          )}
        </fieldset>

        <label className="flex items-start gap-3 text-[14.5px] cursor-pointer">
          <input type="checkbox" className="mt-1 h-5 w-5" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          <span>
            <strong>Make it active now.</strong> <span className="text-ink-2">Old quotes keep their price.</span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={busy || blocked || !csv.trim()}>
            {busy ? "Uploading…" : "Upload rate card"}
          </button>
          {blocked && check ? (
            <span className="hint !mt-0">
              {check.priced === 0 && !check.problems.length && !check.blankLines.length ? "The sheet has no prices yet." : "Fix the sheet above first."}
            </span>
          ) : null}
        </div>
        <ErrorText error={error} />
      </form>
    </Card>
  );
}

function DeductionEditor({ values, onChange }: { values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {DED_GROUPS.map((g) => (
        <div key={g.title} className="rounded-[12px] border border-line p-3">
          <div className="text-[13px] font-bold text-ink-2 mb-2">{g.title}</div>
          <div className="space-y-1.5">
            {g.rows.map((r) => (
              <label key={r.path} className="flex items-center justify-between gap-3">
                <span className="text-[13.5px] min-w-0">{r.label}</span>
                <span className="flex items-center gap-1 shrink-0">
                  <input
                    className="input num !min-h-[36px] !py-1 !px-2 !w-[76px] text-right"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="0.5"
                    value={values[r.path] ?? ""}
                    onChange={(e) => onChange({ ...values, [r.path]: e.target.value })}
                    aria-label={`${g.title}: ${r.label}, percent`}
                  />
                  <span className="text-muted text-[13px]">%</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── one card's prices ────────────────────────────────────── */

function CardDetail({ id, qs, onClose }: { id: string; qs: string; onClose: () => void }) {
  const [data, setData] = useState<{ card: RateCard; modelNames: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api<{ card: RateCard; modelNames: Record<string, string> }>(`/api/partner/rate-cards/${encodeURIComponent(id)}${qs}`)
      .then((r) => live && setData(r))
      .catch((e: Error) => live && setError(e.message));
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return () => {
      live = false;
    };
  }, [id, qs]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const all = data.card.entries.map((e) => ({ ...e, name: data.modelNames[e.modelId] ?? e.modelId }));
    if (!needle) return all;
    return all.filter((e) => `${e.name} ${e.modelId} ${e.variant}`.toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <div ref={ref} className="scroll-mt-24">
      <Card
        title="Prices on this card"
        action={
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        }
      >
        {error ? <ErrorText error={error} /> : null}
        {!data && !error ? <p className="hint">Loading…</p> : null}
        {data ? (
          <div className="space-y-3">
            <h3 className="text-[17px] font-[750] tracking-tight leading-snug m-0">{data.card.source.label}</h3>
            <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink-2">
              <KindPill kind={data.card.source.kind} />
              <span>Effective from {data.card.source.effectiveFrom || "—"}</span>
              <span>·</span>
              <span>
                {data.card.entries.length} phones · quotes valid {data.card.quoteValidityDays} {data.card.quoteValidityDays === 1 ? "day" : "days"}
              </span>
            </div>
            <input
              className="input max-w-[360px]"
              type="search"
              placeholder="Search a phone, model id or storage…"
              aria-label="Search prices"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <p className="hint !mt-0">
              Showing {rows.length} of {data.card.entries.length} · best-condition prices
            </p>
            {rows.length === 0 ? (
              <Empty title="No phone on this card matches" />
            ) : (
              <div className="overflow-x-auto max-h-[520px] overflow-y-auto border border-line rounded-[12px]">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Phone</th>
                      <th>Model id</th>
                      <th>Storage</th>
                      <th className="text-right">
                        Best-condition price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={`${e.modelId}|${e.variant}`}>
                        <td className="font-semibold">{e.name}</td>
                        <td className="num text-[13px] text-muted whitespace-nowrap">{e.modelId}</td>
                        <td className="whitespace-nowrap">{e.variant}</td>
                        <td className="text-right whitespace-nowrap">
                          <Money value={e.maxPrice} className="font-semibold" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/* ── how it works ─────────────────────────────────────────── */

function HowItWorks({ active }: { active: ActiveCardInfo | null }) {
  return (
    <Card title="How rate cards work">
      <details className="text-[14.5px] text-ink-2 leading-relaxed max-w-[80ch]">
        <summary className="cursor-pointer font-semibold text-fix">Show details</summary>
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li>Best-condition price, less a % per problem.</li>
          <li>An unlisted phone gets no price — never a similar model&apos;s.</li>
          <li>A new sheet keeps the active deductions unless changed.</li>
        </ul>
      </details>
      {active ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h3 className="text-[15px] font-bold m-0">Deductions on the active card</h3>
            <KindPill kind={active.kind} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DED_GROUPS.map((g) => (
              <div key={g.title} className="rounded-[12px] border border-line overflow-hidden">
                <div className="px-3 py-2 bg-[color:var(--surface-2)] text-[13px] font-bold text-ink-2">{g.title}</div>
                <table className="w-full text-[13.5px]">
                  <tbody>
                    {g.rows.map((r) => {
                      const bp = bpAt(active.deductions, r.path);
                      return (
                        <tr key={r.path} className="border-t border-line first:border-t-0">
                          <td className="px-3 py-1.5">{r.label}</td>
                          <td className={`px-3 py-1.5 text-right num whitespace-nowrap ${bp ? "font-semibold" : "text-muted"}`}>{bp ? `−${fmtBp(bp)}` : "0%"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {g.note ? <p className="hint px-3 pb-2">{g.note}</p> : null}
              </div>
            ))}
          </div>
          <ul className="mt-4 text-[14px] text-ink-2 space-y-1 list-disc pl-5">
            <li>
              Max off: <strong className="num">{fmtBp(active.maxDeductionBp)}</strong>
            </li>
            <li>
              Floor: <strong className="num">{fmtBp(active.floorBp)}</strong> of the best price
            </li>
            <li>
              Rounded down to <Money value={active.roundTo} className="font-bold" />
            </li>
          </ul>
        </div>
      ) : (
        <p className="hint mt-4">No active card.</p>
      )}
    </Card>
  );
}
