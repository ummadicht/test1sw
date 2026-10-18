import type { CSSProperties, ReactNode } from "react";
import { headline } from "@/components/brand";
import { reportView, type ReportView, type Row, type Tone } from "@/components/counter/gradingView";
import type { ReportEnvelope } from "@/lib/server/gradingReport";
import { PhotoEvidence } from "./PhotoEvidence";
import { ScreenColours } from "./ScreenColours";

/**
 * THE GRADE REPORT, rendered — one issued version, from its body only, so the
 * public link (/r/<token>) and the desk's print view (/cases/<id>/report) show
 * exactly the same content (spec §4.6). Sections, in order: the grade and why
 * (with what the advisor certified by eye), the phone (identity, colour, software,
 * parts, the locks), screen and body (every store-camera photo by angle with its
 * marks boxed, each part in words), the screen colour test (its frames), the
 * tests (each line names its source), battery, faults and parts (no prices), what
 * a buyer must know, sources and references, and the footer (version, ruleset,
 * sha256, "the buyer's inspection decides the final price"). As rich as the store
 * camera's own report; photos proxied by SwapUp. A version issued before a section
 * existed simply doesn't have it.
 *
 * Under the SwapUp grade, always: what the grade is (today's wording) and the A–D line.
 * No money anywhere — the body carries none, and nothing here adds any.
 *
 * `variant` only changes the look: "public" is the customer brand (grey tint,
 * white r=26 cards, Plus Jakarta Sans headlines — the page wraps it in `.xc`);
 * "desk" is the counter's cards. Phone-first; prints on A4.
 */

const PALETTE: Record<"public" | "desk", CSSProperties> = {
  public: {
    ["--rv-ink" as string]: "#111111",
    ["--rv-muted" as string]: "#6e6e73",
    ["--rv-line" as string]: "#e5e5ea",
    ["--rv-soft" as string]: "#f4f4f6",
    ["--rv-up" as string]: "#0a7d5a",
    ["--rv-warn" as string]: "#b25e00",
    ["--rv-bad" as string]: "#c23030",
    ["--rv-accent" as string]: "#0381fe",
  },
  desk: {
    ["--rv-ink" as string]: "var(--ink)",
    ["--rv-muted" as string]: "var(--muted)",
    ["--rv-line" as string]: "var(--line)",
    ["--rv-soft" as string]: "var(--surface-2)",
    ["--rv-up" as string]: "var(--up)",
    ["--rv-warn" as string]: "var(--warn)",
    ["--rv-bad" as string]: "var(--bad)",
    ["--rv-accent" as string]: "var(--fix)",
  },
};

const TONE_TEXT: Record<Tone, string> = {
  up: "text-[color:var(--rv-up)]",
  warn: "text-[color:var(--rv-warn)]",
  bad: "text-[color:var(--rv-bad)]",
  plain: "text-[color:var(--rv-ink)]",
};

export function GradingReportView({
  env,
  token,
  variant,
  qr,
  aside,
}: {
  env: Pick<ReportEnvelope, "version" | "issuedAt" | "reason" | "final" | "sha256" | "body">;
  token: string;
  variant: "public" | "desk";
  /** A QR of this exact version's public link, and the link it encodes. */
  qr?: { dataUrl: string; url: string } | null;
  /** Anything the page adds after the grade (the desk's staff-only section goes at the end instead). */
  aside?: ReactNode;
}) {
  const v = reportView(env, token);
  const pub = variant === "public";
  const card = pub ? "xc-card print:border print:border-[color:var(--rv-line)] print:break-inside-avoid" : "card card-pad print:break-inside-avoid";
  const h = pub ? `${headline.className} font-extrabold` : "font-[760]";

  return (
    <div style={PALETTE[variant]} className="space-y-4 text-[color:var(--rv-ink)]">
      {/* On paper a closed "Show details" prints open. */}
      <style>{`@media print { .rv-details::details-content { content-visibility: visible; display: block; } }`}</style>
      <GradeCard v={v} card={card} h={h} pub={pub} />
      {aside}

      <Section title="The phone" card={card} h={h}>
        <Rows rows={v.phone} />
        {v.locks.length ? (
          <div className="mt-3">
            <div className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--rv-muted)] mb-1">Locks</div>
            <Rows rows={v.locks} />
          </div>
        ) : null}
        <p className="mt-3 text-[13px] text-[color:var(--rv-muted)]">
          Case <span className="num">{v.ref}</span> · {v.store}
          {v.storeCode ? ` (${v.storeCode})` : ""}
        </p>
      </Section>

      <Section title="Screen and body" card={card} h={h}>
        {v.condition ? <Rows rows={v.condition} /> : <p className="text-[14px]">Not recorded.</p>}
        <p className="mt-3 text-[14px]">{v.camera.summary}</p>
        {v.screen || !v.camera.lcd ? null : <p className="text-[14px]">{v.camera.lcd}</p>}
        {v.camera.photos.length || v.screen || (!v.camera.findings.length && v.camera.caption) ? (
          <PhotoEvidence camera={v.camera} />
        ) : v.camera.findings.length ? (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {v.camera.findings.map((f, i) => (
              <li key={`${f.part}-${i}`} className="flex gap-3 items-start rounded-[14px] border border-[color:var(--rv-line)] p-2.5 print:break-inside-avoid">
                {f.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- streamed by SwapUp from the camera's store; nothing to optimise
                  <img src={f.photo} alt={`${f.part}: ${f.what}`} width={88} height={88} loading="lazy" className="shrink-0 w-[88px] h-[88px] object-cover rounded-[10px] bg-[color:var(--rv-soft)]" />
                ) : null}
                <div className="min-w-0 text-[13.5px] leading-snug">
                  <div className="font-semibold">{f.part}</div>
                  <div>{f.what}</div>
                  <div className="text-[12.5px] text-[color:var(--rv-muted)]">{f.severity}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {v.camera.photos.length && v.camera.findings.length ? (
          <ul className="mt-2 text-[13.5px] space-y-0.5">
            {v.camera.findings.map((f, i) => (
              <li key={`${f.part}-${i}`}>
                <span className="font-semibold">{f.part}</span>: {f.what} <span className="text-[color:var(--rv-muted)]">· {f.severity}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {v.camera.parts.length ? (
          <div className="mt-3">
            <div className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--rv-muted)] mb-1">Part by part</div>
            <ul className="divide-y divide-[color:var(--rv-line)]">
              {v.camera.parts.map((p) => (
                <li key={p.part} className="py-1.5 text-[14px] leading-snug">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold">{p.part}</span>
                    <span className="shrink-0">{p.word}</span>
                  </div>
                  {p.note ? <div className="text-[12.5px] text-[color:var(--rv-muted)]">{p.note}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      {v.screen ? (
        <Section title="Screen colours" card={card} h={h}>
          <ScreenColours screen={v.screen} />
        </Section>
      ) : null}

      <Section title="Tests" card={card} h={h} sub={v.testCounts}>
        <ul className="divide-y divide-[color:var(--rv-line)]">
          {v.tests.map((t) => (
            <li key={t.id} className="py-2.5 print:break-inside-avoid">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 font-semibold text-[15px] leading-snug">
                  {t.name}
                  {t.key ? <span className="ml-2 align-middle text-[11px] font-bold uppercase tracking-wider text-[color:var(--rv-muted)]">key test</span> : null}
                </div>
                <div className={`shrink-0 text-[14px] font-bold ${TONE_TEXT[t.tone]}`}>{t.word}</div>
              </div>
              {t.sources.length ? (
                <ul className="mt-0.5 text-[12.5px] text-[color:var(--rv-muted)] leading-snug">
                  {t.sources.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 text-[12.5px] text-[color:var(--rv-muted)]">No result.</div>
              )}
            </li>
          ))}
        </ul>
        {v.otherTests.length ? (
          <div className="mt-4">
            <div className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--rv-muted)]">Other Phonecheck tests</div>
            <ul className="mt-1.5 space-y-1">
              {v.otherTests.map((o, i) => (
                <li key={`${o.name}-${i}`} className="flex items-start justify-between gap-3 text-[14px]">
                  <span className="min-w-0">
                    {o.name}
                    <span className="text-[12.5px] text-[color:var(--rv-muted)]">
                      {" "}
                      · {o.source}
                      {o.manual ? " (manual check)" : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 font-bold ${TONE_TEXT[o.tone]}`}>{o.word}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title="Battery health" card={card} h={h}>
        <div className={`text-[28px] leading-none font-[780] num ${TONE_TEXT[v.battery.tone]}`}>{v.battery.value}</div>
        <p className="mt-2 text-[13px] text-[color:var(--rv-muted)]">{v.battery.note}</p>
        {v.battery.readings.length ? (
          <ul className="mt-2 text-[13.5px] space-y-0.5">
            {v.battery.readings.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Faults and parts needed" card={card} h={h}>
        {v.faults.length ? (
          <ul className="space-y-1.5 text-[14.5px]">
            {v.faults.map((f) => (
              <li key={f.label}>
                <span className="font-semibold">{f.label}</span>
                <span className="text-[12.5px] text-[color:var(--rv-muted)]"> · found by {f.sources}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14.5px]">No faults recorded.</p>
        )}
        {v.repairs.parts.length ? (
          <p className="mt-3 text-[14px]">
            <span className="font-semibold">Parts: </span>
            {v.repairs.parts.join(", ")}
          </p>
        ) : null}
        {v.repairs.inspection.length ? (
          <p className="mt-1 text-[14px]">
            <span className="font-semibold">Needs inspection: </span>
            {v.repairs.inspection.join(", ")}
          </p>
        ) : null}
      </Section>

      {v.disclose.length ? (
        <Section title="What a buyer must know" card={card} h={h}>
          <ul className="list-disc pl-5 space-y-1 text-[14.5px]">
            {v.disclose.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {v.references.length ? (
        <Section title="Sources and references" card={card} h={h}>
          <Rows rows={v.references} />
        </Section>
      ) : null}

      <footer className={`${card} text-[12.5px] text-[color:var(--rv-muted)]`}>
        <p className="text-[14.5px] leading-snug text-[color:var(--rv-ink)] font-semibold">{v.footer.buyerLine}</p>
        <div className="mt-3 flex flex-col sm:flex-row print:flex-row gap-4 items-start">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-[14px] text-[color:var(--rv-ink)] font-semibold">
              Version {v.footer.version} · issued {v.footer.issuedAt}
            </div>
            {v.footer.checkedBy ? <div>Recorded by {v.footer.checkedBy}</div> : null}
            <Details>
              <div>
                {v.footer.final ? "Final — " : ""}
                {v.footer.reason} · rules {v.footer.ruleset}
              </div>
              <div className="num break-all text-[color:var(--rv-ink)]">sha256 {v.footer.sha256}</div>
              <div className="break-words">{v.footer.hashNote}</div>
            </Details>
          </div>
          {qr ? (
            <div className="shrink-0 flex sm:flex-col print:flex-col items-center gap-3 sm:gap-1 sm:text-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
              <img src={qr.dataUrl} alt="QR code for this version of the report" width={116} height={116} className="w-[116px] h-[116px] shrink-0" />
              <div className="max-w-[180px] sm:max-w-[150px] break-all text-[10.5px]">{qr.url}</div>
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function GradeCard({ v, card, h, pub }: { v: ReportView; card: string; h: string; pub: boolean }) {
  return (
    <section className={card} aria-labelledby="grade-label">
      <div className={`text-[12.5px] font-bold uppercase tracking-[0.1em] ${pub ? "text-[color:var(--rv-accent)]" : "text-[color:var(--rv-muted)]"}`}>SwapUp grade</div>
      <h1 id="grade-label" className={`${h} mt-1 text-[34px] sm:text-[40px] leading-[1.08] tracking-[-0.02em] ${TONE_TEXT[v.headline.tone]}`}>
        {v.headline.label}
      </h1>
      {v.headline.extra ? <p className="mt-1.5 text-[15.5px] font-semibold">{v.headline.extra}</p> : null}
      {v.why ? <p className="mt-2 text-[15.5px] leading-relaxed">{v.why}</p> : null}
      {v.checked.length ? (
        <div className="mt-3 rounded-[14px] bg-[color:var(--rv-soft)] px-3.5 py-2.5">
          <div className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--rv-up)]">Certified by the advisor</div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5 text-[14px] leading-snug">
            {v.checked.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {v.check.length ? (
        <div className="mt-3 rounded-[14px] bg-[color:var(--rv-soft)] px-3.5 py-2.5">
          <div className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--rv-warn)]">To check by hand</div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5 text-[14px] leading-snug">
            {v.check.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* The rest of the why, what the grade is and the A–D line: one tap away, closed. */}
      <Details>
        {v.more.length ? (
          <ul className="list-disc pl-5 space-y-0.5 text-[14px] leading-snug text-[color:var(--rv-ink)]">
            {v.more.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <p>{v.scale}.</p>
        <p>{v.letterNote}</p>
      </Details>
    </section>
  );
}

/** "Show details" — closed on screen, open on paper (print shows everything). */
function Details({ children }: { children: ReactNode }) {
  return (
    <details className="group mt-3 rv-details">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-block text-[13px] font-semibold text-[color:var(--rv-accent)] print:hidden">
        <span className="group-open:hidden">Show details</span>
        <span className="hidden group-open:inline">Hide details</span> <span aria-hidden>›</span>
      </summary>
      <div className="mt-1.5 space-y-1 text-[12.5px] leading-snug text-[color:var(--rv-muted)]">{children}</div>
    </details>
  );
}

function Section({ title, sub, card, h, children }: { title: string; sub?: string; card: string; h: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className={`${h} text-[18px] leading-snug`}>{title}</h2>
      {sub ? <p className="text-[13px] text-[color:var(--rv-muted)]">{sub}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,38%)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[14.5px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-[color:var(--rv-muted)]">{r.label}</dt>
          <dd className="min-w-0 break-words">
            <span className={r.label.startsWith("IMEI") ? "num" : ""}>{r.value}</span>
            {r.note ? <span className="text-[12.5px] text-[color:var(--rv-muted)]"> · {r.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
