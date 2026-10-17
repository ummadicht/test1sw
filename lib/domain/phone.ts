/**
 * A customer's mobile number, as the counter keys it. Cases store the phone as
 * bare digits (createCase / lockTradeIn), so a lookup must reduce what was typed
 * to the same 10 digits before it can match anything.
 *
 * The rule is lockTradeIn's: a 10-digit Indian mobile starts with 6–9. The
 * country code (+91 / 91) and the trunk 0 that people habitually type in front
 * are dropped first — a "+" in a query string also arrives as a space, which
 * the digit filter ignores anyway.
 */

/** The 10 digits, or null when this is not an Indian mobile number. */
export function indianMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
