import type { CaseView, CasePatch } from "@/lib/server/cases";

/** What every step of the case workspace gets: the case, and the two ways to change it. */
export type CaseOps = {
  view: CaseView;
  /** Counter role and the case is still at the counter (draft / quoted). */
  editable: boolean;
  busy: boolean;
  /**
   * PATCH the case. `optimistic` is applied at once so the next tap builds on
   * it; the server's CaseView replaces it when it lands. Resolves to an error
   * message, or null on success.
   */
  save: (patch: CasePatch, optimistic?: Partial<CaseView>) => Promise<string | null>;
  /** POST /api/cases/[id]/action. Resolves to an error message, or null. */
  act: (action: string, extra?: Record<string, unknown>) => Promise<string | null>;
};

export type ModelOption = { id: string; brand: string; model: string; series: string | null; releaseYear: number | null; supportEndYear: number | null; variants: string[] };

export type CampaignBand = { name: string; minBp: number; maxBp: number; capRupees: number | null };

export type PickupInfo = { ref: string; status: string; collectedAt: string | null; collectorName: string | null; settledAt: string | null };
