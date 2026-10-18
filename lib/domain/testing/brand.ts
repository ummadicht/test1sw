/**
 * TESTS ONLY — does a text name the former buyback partner's brand?
 *
 * Owner, 2026-10-17 and 2026-10-18: don't refer to it — no screen, API answer, identifier, env
 * name, file name or comment names it. To keep that true while other work lands, tests check for
 * it; and so that the codebase itself never spells the word, it is kept here only as the SHA-256 of
 * its lower-case form (7 letters). `namesBrand` hashes each 7-letter window of the text that starts
 * and ends with the same letters as the word, so a scan of the whole repository stays fast.
 */
import { createHash } from "node:crypto";

const WORD_SHA256 = "5d438033ba8011f147c966d40111bb23203fd3c34fd29ad0e3c734a2d86abe0f";
const LEN = 7;
const FIRST = 99; // the word's first letter, as a char code
const LAST = 121; // and its last

export function namesBrand(text: string): boolean {
  const t = text.toLowerCase();
  for (let i = 0; i + LEN <= t.length; i++) {
    if (t.charCodeAt(i) !== FIRST || t.charCodeAt(i + LEN - 1) !== LAST) continue;
    if (createHash("sha256").update(t.slice(i, i + LEN)).digest("hex") === WORD_SHA256) return true;
  }
  return false;
}
