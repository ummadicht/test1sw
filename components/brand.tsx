import { Plus_Jakarta_Sans } from "next/font/google";

/*
 * The customer- and tablet-facing brand (owner, 2026-10-17): TEXT ONLY — the
 * wordmark "SWAPUP EXPERIENCE CENTER" in letter-spaced caps, Samsung-like blue
 * ink, with the store's name under it. No logo, no mark, no image. Headlines
 * use Plus Jakarta Sans (a free look-alike for Samsung Sharp Sans); body text
 * stays on the system/Inter stack. Colours: the `.xc` tokens in globals.css.
 */

export const headline = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["700", "800"], display: "swap" });

export const WORDMARK = "SWAPUP EXPERIENCE CENTER";

export function Wordmark({ store, align = "center" }: { store?: string | null; align?: "center" | "left" }) {
  return (
    <div className={align === "center" ? "text-center" : ""}>
      <div className={`${headline.className} text-[13px] font-extrabold tracking-[0.22em] text-[color:var(--xc-brand)]`}>{WORDMARK}</div>
      {store ? <div className="mt-1 text-[14px] text-[color:var(--xc-muted)]">{store}</div> : null}
    </div>
  );
}

/** The "→" on the right of a pill button. */
export function PillArrow() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
      <path d="M4 12h15m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
