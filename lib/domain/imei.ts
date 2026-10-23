/**
 * IMEI handling. A 15-digit IMEI ends in a Luhn check digit computed over the
 * first 14 digits; that is what separates a real IMEI from any other 15-digit
 * number printed on a box. A failed check is a WARNING the advisor confirms,
 * not a silent drop — real labels get misread, and dropping the scan would only
 * teach people to type something that passes.
 */

export const digits = (s: string): string => (s || "").replace(/\D/g, "");

export function luhnCheckDigit(body14: string): number {
  const d = digits(body14);
  if (d.length !== 14) throw new Error("IMEI body must be 14 digits");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return (10 - (sum % 10)) % 10;
}

export function luhnValid(imei: string): boolean {
  const d = digits(imei);
  if (d.length !== 15) return false;
  return luhnCheckDigit(d.slice(0, 14)) === Number(d[14]);
}

export type ImeiRead =
  | { ok: true; imei: string; checkDigit: "valid" }
  | { ok: true; imei: string; checkDigit: "invalid" }
  | { ok: false; reason: string };

/**
 * Read whatever the advisor typed or scanned. 14 digits are completed with the
 * check digit (some box barcodes omit it); anything else must be exactly 15.
 */
export function readImei(raw: string): ImeiRead {
  const d = digits(raw);
  if (d.length === 14) return { ok: true, imei: d + String(luhnCheckDigit(d)), checkDigit: "valid" };
  if (d.length !== 15) {
    return { ok: false, reason: d.length ? `An IMEI has 15 digits — this has ${d.length}.` : "Enter the IMEI (dial *#06#)." };
  }
  return luhnValid(d) ? { ok: true, imei: d, checkDigit: "valid" } : { ok: true, imei: d, checkDigit: "invalid" };
}

/** 35•••••••••1234 — enough to match a device in hand, not enough to reuse. */
export function maskImei(imei: string): string {
  const d = digits(imei);
  if (d.length < 6) return d;
  return d.slice(0, 2) + "•".repeat(d.length - 6) + d.slice(-4);
}

/* ─────────────────────────── the government IMEI register (KYM) ─────────────────────────── */

/** Result of the government IMEI register check (Sanchar Saathi / CEIR "Know Your Mobile"). */
export type KymStatus = "clear" | "blacklisted" | "duplicate" | "in_use";
export const KYM_LABEL: Record<KymStatus, string> = {
  clear: "No block — OK to buy",
  blacklisted: "Black-listed (reported lost/stolen)",
  duplicate: "Duplicate IMEI",
  in_use: "Already in use",
};

/**
 * Why no test starts on an early KYM answer that isn't clear — the register's own words (SUP-17).
 * Only GSMA's "blacklisted" is said as "reported lost or stolen" (imeiResolve.ts BLACKLISTED): a
 * duplicate or in-use IMEI is checked, and the lock's own KYM answer decides.
 */
export function kymEarlyStop(status: string): string {
  const said = Object.hasOwn(KYM_LABEL, status) ? KYM_LABEL[status as KymStatus] : status;
  return `IMEI register says "${said}" — check it before testing.`;
}
