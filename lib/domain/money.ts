/**
 * Money in SwapUp is whole Indian rupees, held as integers.
 *
 * Every percentage is carried in BASIS POINTS (1% = 100 bp) so that "3.5%" is
 * the integer 350 and the arithmetic never sees a float until display. The one
 * place a fraction of a rupee can appear — a percentage of a price — always
 * rounds DOWN: a promotion must never promise a rupee the ledger cannot pay.
 */

export type Rupees = number;
export type BasisPoints = number;

export const BP_PER_PERCENT = 100;

export function assertRupees(n: number, what = "amount"): Rupees {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${what} must be a whole number of rupees (got ${n})`);
  }
  return n;
}

/** floor(amount × bp / 10000), exact in integer arithmetic for any realistic price. */
export function pctOf(amount: Rupees, bp: BasisPoints): Rupees {
  if (amount <= 0 || bp <= 0) return 0;
  return Math.floor((amount * bp) / 10_000);
}

export function bpToPct(bp: BasisPoints): number {
  return bp / BP_PER_PERCENT;
}

export function pctToBp(pct: number): BasisPoints {
  return Math.round(pct * BP_PER_PERCENT);
}

/** Round DOWN to a cash denomination (default ₹10). */
export function roundDown(amount: Rupees, step = 10): Rupees {
  if (amount <= 0) return 0;
  return Math.floor(amount / step) * step;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** ₹1,23,456 — Indian digit grouping, no paise. */
export function inr(amount: Rupees | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  const neg = amount < 0;
  const s = Math.abs(Math.round(amount)).toString();
  let out: string;
  if (s.length <= 3) out = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    out = `${rest},${last3}`;
  }
  return `${neg ? "−" : ""}₹${out}`;
}

/** "3.5%" from 350 bp — trims a trailing .0. */
export function fmtBp(bp: BasisPoints): string {
  const p = bp / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(2).replace(/0$/, "")}%`;
}
