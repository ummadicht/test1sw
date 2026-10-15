"use client";

/**
 * Shared UI primitives. Pages compose these; they never re-style money,
 * meters or source badges on their own, so a sample price looks the same
 * everywhere and a full credit line is red everywhere.
 */
import type { ReactNode } from "react";
import { inr, fmtBp } from "@/lib/domain/money";

export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span className="brandmark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
        <path d="M7 17V7m0 0L3.5 10.5M7 7l3.5 3.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 7v10m0 0l3.5-3.5M17 17l-3.5-3.5" stroke="#3ddc97" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function Money({ value, className = "", sign = false }: { value: number | null | undefined; className?: string; sign?: boolean }) {
  if (value === null || value === undefined) return <span className={`num text-muted ${className}`}>—</span>;
  const s = inr(value);
  return <span className={`num ${className}`}>{sign && value > 0 ? `+${s}` : s}</span>;
}

export function Pct({ bp }: { bp: number | null | undefined }) {
  return <span className="num">{bp === null || bp === undefined ? "—" : fmtBp(bp)}</span>;
}

export function Card({ title, action, children, className = "", pad = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          {title ? <h2 className="section-title">{title}</h2> : <span />}
          {action}
        </header>
      )}
      <div className={pad ? "px-5 pb-5 pt-2" : ""}>{children}</div>
    </section>
  );
}

export function Banner({ tone = "info", children, icon }: { tone?: "info" | "warn" | "bad" | "up" | "sample"; children: ReactNode; icon?: ReactNode }) {
  const cls = tone === "info" ? "banner" : `banner banner-${tone}`;
  const glyph = icon ?? (tone === "bad" ? "⛔" : tone === "warn" ? "⚠" : tone === "up" ? "✓" : tone === "sample" ? "◆" : "ℹ");
  return (
    <div className={cls} role={tone === "bad" ? "alert" : undefined}>
      <span aria-hidden className="leading-5">{glyph}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Where a price came from. A SAMPLE price is unmistakable everywhere it appears. */
export function SourceBadge({ kind, label }: { kind: string | null | undefined; label?: string | null }) {
  if (!kind) return null;
  if (kind === "sample") return <span className="pill pill-sample" title={label ?? undefined}>◆ SAMPLE price</span>;
  if (kind === "partner_live") return <span className="pill pill-up" title={label ?? undefined}>● Live partner quote</span>;
  if (kind === "partner_ratecard") return <span className="pill pill-fix" title={label ?? undefined}>Partner rate card</span>;
  if (kind === "oem_public") return <span className="pill" title={label ?? undefined}>Published price</span>;
  if (kind === "manual") return <span className="pill pill-warn" title={label ?? undefined}>Entered by staff</span>;
  return <span className="pill" title={label ?? undefined}>{label || kind}</span>;
}

export function Meter({ value, state }: { value: number; state?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="meter" data-state={state} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "bad" | "warn" }) {
  const color = tone === "up" ? "text-up" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "";
  return (
    <div>
      <div className="section-title">{label}</div>
      <div className={`kpi mt-1 ${color}`}>{value}</div>
      {sub ? <div className="hint">{sub}</div> : null}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {error ? <span className="hint" style={{ color: "var(--bad)" }}>{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <div className="text-[15px] font-semibold">{title}</div>
      {children ? <div className="hint mt-1">{children}</div> : null}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  draft: "",
  quoted: "pill-fix",
  repair_chosen: "pill-fix",
  walked_away: "",
  locked: "pill-warn",
  cancelled: "",
  in_pickup: "pill-warn",
  collected: "pill-up",
  cleared: "pill-up",
  regraded: "pill-warn",
  rejected: "pill-bad",
  not_received: "pill-bad",
  requested: "pill-warn",
  scheduled: "pill-fix",
  reconciled: "pill-up",
  settled: "pill-up",
};

export function StatusPill({ status, label }: { status: string; label: string }) {
  return <span className={`pill ${STATUS_TONE[status] ?? ""}`}>{label}</span>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="banner banner-bad mt-3" role="alert">
      <span aria-hidden>⛔</span>
      <div>{error}</div>
    </div>
  );
}

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}
