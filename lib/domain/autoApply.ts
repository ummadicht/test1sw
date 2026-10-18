/**
 * THE ANSWER, REACHED BY ITSELF (owner, 2026-10-17: "Reduce the flow"): when the
 * customer's phone has finished its tests and the store camera's grade is in, the
 * results go on the case without anyone tapping "Apply to case". The advisor's
 * next screen is the answer (refurb quote vs trade-in + bonus).
 *
 * This decides only WHEN to try. Apply itself (lib/server/testSessions.ts
 * applyTestSession) keeps every gate it has — the camera grade still being worked
 * out, the case past the counter, nothing to apply — and when it refuses, its
 * one-line reason is shown with a Retry. A refusal is not tried again until the
 * session changes (new results, a new phase, a certification), so a poll every
 * two seconds never hammers it.
 *
 * "The camera grade is in" includes the advisor's certification when the camera
 * couldn't decide: the card ("Check the phone") sits inside the camera step, and
 * the customer's phone shows the test colours only until the results are applied —
 * so applying first would end the colours before the screen was looked at, and
 * the answer's numbers would move after the customer saw them. Every row on that
 * card has a choice for every phone (Cracked, Can't see…), so the wait always
 * ends with the advisor's taps. A manual Apply (Retry, "Apply the results so
 * far") is never held by it.
 *
 * Pure functions only — no database, no clock.
 */

export type AutoApplyWait = "tests" | "camera" | "certify";

export type AutoApplyView =
  /** Nothing is waiting: the session ended (expired, cancelled) without results on the case. */
  | { state: "off" }
  /** Not yet — the phone is still testing, the camera grade is coming, or the advisor is checking the phone. */
  | { state: "waiting"; for: AutoApplyWait; text: string }
  /** Everything is in: the server puts the results on the case now. */
  | { state: "ready" }
  /** Apply said no; its reason, as it said it. Retry is a manual Apply. */
  | { state: "refused"; reason: string }
  | { state: "applied" };

export const WAIT_TEXT: Readonly<Record<AutoApplyWait, string>> = {
  tests: "The phone is still testing.",
  camera: "Camera grade coming — the answer opens itself.",
  certify: "Tap what you see — the answer opens itself.",
};

type Rows = Partial<Record<string, unknown>>;

/** The camera couldn't decide the screen or the body: "Check the phone" is on the camera step. */
export function cameraUndecided(needed: readonly string[]): boolean {
  return needed.includes("screen") || needed.includes("body");
}

/**
 * That card is on screen, can still be tapped, and a row on it is still untapped. A card nobody
 * can tap any more (the case left the counter: canEdit false) holds nothing — Apply is tried, and
 * its own refusal ("The case is past the counter.") is what the advisor sees.
 */
export function certifyWaiting(certify: { needed: readonly string[]; rows: Rows; canEdit?: boolean } | null | undefined): boolean {
  if (!certify || certify.canEdit === false || !cameraUndecided(certify.needed)) return false;
  return certify.needed.some((r) => !certify.rows[r]);
}

export type AutoApplyInput = {
  status: string;
  /** The store camera's grade (or its screen check's verdict) can still change (cameraGradePending). */
  gradePending: boolean;
  /** The session's "Check the phone" block (needed rows, rows tapped). null = none (a partner, an older call). */
  certify: { needed: readonly string[]; rows: Rows; canEdit?: boolean } | null;
  /** The last time Apply refused, and the session version it refused (its updated_at). */
  refused: { reason: string; key: string } | null;
  /** This session's version now (its updated_at). */
  key: string;
};

export function autoApplyState(i: AutoApplyInput): AutoApplyView {
  switch (i.status) {
    case "applied":
      return { state: "applied" };
    case "expired":
    case "cancelled":
      return { state: "off" };
    case "complete":
      break;
    default:
      return { state: "waiting", for: "tests", text: WAIT_TEXT.tests };
  }
  if (i.gradePending) return { state: "waiting", for: "camera", text: WAIT_TEXT.camera };
  if (certifyWaiting(i.certify)) return { state: "waiting", for: "certify", text: WAIT_TEXT.certify };
  if (i.refused && i.refused.key === i.key) return { state: "refused", reason: i.refused.reason };
  return { state: "ready" };
}
