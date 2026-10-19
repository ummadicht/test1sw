"use client";

/**
 * Shared UI primitives. Pages compose these; they never re-style money,
 * meters or source badges on their own, so a price's source looks the same
 * everywhere and a full credit line is red everywhere.
 */
import { headline } from "./brand";
import type { ReactNode } from "react";
import { inr, fmtBp } from "@/lib/domain/money";
import { RETIRED_QUOTE_LABEL } from "@/lib/domain/ratecard";

/**
 * The desk's brand: TEXT ONLY (owner, 2026-10-17 — "no logo"). "SWAPUP" in
 * letter-spaced caps, the same blue ink as the customer pages' wordmark.
 */
export function BrandMark({ size = 15, light = false }: { size?: number; light?: boolean }) {
  return (
    <span className={`${headline.className} font-extrabold`} style={{ fontSize: size, letterSpacing: "0.2em", color: light ? "#fff" : "#1428a0" }}>
      SWAPUP
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

export function Banner({ tone = "info", children, icon }: { tone?: "info" | "warn" | "bad" | "up" | "test"; children: ReactNode; icon?: ReactNode }) {
  const cls = tone === "info" ? "banner" : `banner banner-${tone}`;
  const glyph = icon ?? (tone === "bad" ? "⛔" : tone === "warn" ? "⚠" : tone === "up" ? "✓" : tone === "test" ? "◆" : "ℹ");
  return (
    <div className={cls} role={tone === "bad" ? "alert" : undefined}>
      <span aria-hidden className="leading-5">{glyph}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Where a price came from: PriceIQ, the partner's rate card, a published price (or an older build's typed quote, history only). */
export function SourceBadge({ kind, label }: { kind: string | null | undefined; label?: string | null }) {
  if (!kind || kind === "none") return null;
  if (kind === "partner_ratecard") return <span className="pill pill-fix" title={label ?? undefined}>Partner rate card</span>;
  if (kind === "partner_manual") return <span className="pill" title={label ?? undefined}>Partner's app</span>;
  if (kind === "approximate") return <span className="pill" title={label ?? undefined}>Approximate</span>;
  if (kind === "priceiq") return <span className="pill pill-fix" title={label ?? undefined}>PriceIQ</span>;
  if (kind === "oem_public") return <span className="pill" title={label ?? undefined}>Published price</span>;
  if (kind === "manual" || kind === "client") return <span className="pill pill-warn" title={label ?? undefined}>Entered by staff</span>;
  // Any other kind is a price source SwapUp no longer has (an older build's quote): never its stored label.
  return <span className="pill pill-warn" title={RETIRED_QUOTE_LABEL}>{RETIRED_QUOTE_LABEL}</span>;
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
