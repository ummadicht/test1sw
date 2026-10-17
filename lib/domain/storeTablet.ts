/**
 * STORE TABLET — the counter tablet stays signed in for the store; each advisor
 * unlocks it with their name and a 4-digit PIN (docs/STORE-TABLET.md).
 *
 * A PIN is a weak secret on purpose: it only works together with the tablet's
 * own long-lived device token, which never leaves the store's tablet. What keeps
 * it honest is that the obvious PINs are refused and a run of wrong guesses
 * locks that person on that tablet for a while.
 *
 * Pure rules only — no database, no clock of its own (callers pass `now`).
 */

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 10 * 60_000;

/** The tablet goes back to "Who's serving?" after this long untouched. The app keeps its own copy. */
export const TABLET_IDLE_MS = 15 * 60_000;

/**
 * null when the PIN is acceptable, else the sentence to show. Refused: anything
 * but exactly 4 digits; one digit repeated (1111); a straight run up or down
 * (0123, 1234, 4321, 9876). Runs don't wrap — 8901 is allowed.
 */
export function pinProblem(pin: unknown): string | null {
  // Only a string: a number would lose the leading zero of "0258".
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) return "The PIN is 4 digits.";
  const d = [...pin].map(Number);
  const steps = [d[1] - d[0], d[2] - d[1], d[3] - d[2]];
  // Every step the same and 0 (1111), +1 (1234) or −1 (4321).
  if (steps.every((s) => s === steps[0]) && Math.abs(steps[0]) <= 1) return "Pick a PIN that isn't a run or one repeated digit.";
  return null;
}

/**
 * One more wrong PIN (or password, on the tablet) for this person on this
 * tablet. `failures` is the count before this one. The fifth in a row locks
 * them for PIN_LOCK_MS; `triesLeft` is how many more they get before that.
 */
export function afterWrongPin(failures: number, now: number): { failures: number; lockedUntil: number | null; triesLeft: number } {
  const before = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  const next = before + 1;
  if (next >= PIN_MAX_FAILURES) return { failures: next, lockedUntil: now + PIN_LOCK_MS, triesLeft: 0 };
  return { failures: next, lockedUntil: null, triesLeft: PIN_MAX_FAILURES - next };
}

/** Is a lock (stored as an ISO time) still running? An unreadable time is not a lock. */
export function isLocked(lockedUntil: string | null, now: number): boolean {
  if (!lockedUntil) return false;
  const t = Date.parse(lockedUntil);
  return Number.isFinite(t) && t > now;
}

/** null when the tablet's name is usable ("Counter tablet 1"), else the sentence to show. */
export function deviceNameProblem(name: unknown): string | null {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 2 || n.length > 40) return "Give the tablet a name of 2 to 40 characters, like “Counter tablet 1”.";
  return null;
}

/** At most this many enrolled (not removed) tablets per store. */
export const MAX_TABLETS_PER_STORE = 10;
/**
 * A person's wrong PINs across ALL of the store's tablets (removed ones too)
 * within PERSON_PIN_WINDOW_MS; at the budget, PIN unlock stops everywhere until
 * they set a new PIN with their password. Each tablet's own 5-try lock still
 * applies first — this only stops extra tablets from buying extra guesses.
 */
export const PERSON_PIN_BUDGET = 10;
export const PERSON_PIN_WINDOW_MS = 24 * 60 * 60_000;
