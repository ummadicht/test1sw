/**
 * THE HAND-OVER CONFIRM — the four checks the law and the money need before the store
 * takes a phone, confirmed with ONE tick (owner, 2026-10-17: "Reduce the flow"). The
 * same words as SwapUp Store's "Take the trade-in" (~/projects/swapup-mobile
 * src/store/lock.ts). The server still receives each of the four flags and still
 * refuses a lock without any one of them (lib/server/cases.ts lockTradeIn); the hint
 * under the tick says what each means, so nothing is confirmed unread.
 *
 * Pure — `node --test` loads it (handover.test.ts).
 */
export const HANDOVER_KEYS = ["ownership", "simRemoved", "imeiMatches", "noFinanceLock"] as const;
export type HandoverKey = (typeof HANDOVER_KEYS)[number];

export const HANDOVER_LABEL = "Owner confirmed · SIM out · IMEI matches · no EMI/lock";
export const HANDOVER_HINT = "Customer owns it; SIM and memory card out; *#06# matches; no EMI or lender lock.";

/** One tick → the four flags the lock sends, each set to it. */
export function handoverChecks(on: boolean): Record<HandoverKey, boolean> {
  return { ownership: on, simRemoved: on, imeiMatches: on, noFinanceLock: on };
}
