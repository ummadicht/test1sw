/**
 * THE ADVISOR CERTIFIES — when the store camera can't decide, the advisor looks
 * at the phone and taps what they see, by name (owner, 2026-10-17: "advisor
 * certify lcd in its app instead of asking"). The customer is never asked about
 * condition: the camera tests it; this is the person standing in for the camera.
 *
 * One card ("Check the phone" in SwapUp Store), one tap per row:
 *
 *   screen   while the customer's phone shows the test colours:
 *            OK · Scratches · Lines or spots · Cracked
 *   body     Like new · Scuffs · Dents · Back cracked · Bent
 *   liquid   the liquid indicator: Clean · Tripped · Can't see
 *
 * What a tap does to the case (certifyRow): faults are added with source
 * "advisor" and remembered on the row (`added`), so changing the row takes them
 * off again — only when this row put them there and nothing else found them.
 * The screen and body become the certified value, but never better than the
 * case's faults or what the store camera confirmed (its floor): the camera may
 * only make the phone worse, and so may the advisor. The display test reads the
 * screen row (lib/domain/grading.ts): OK or Scratches is a pass, Lines or spots
 * a fail, Cracked says nothing about the display.
 *
 * Pure functions only — no database, no network, no clock (callers pass times).
 */
import {
  type BodyState,
  type ConditionAnswers,
  type FaultId,
  type IssueId,
  type ScreenState,
  BODY_ORDER,
  FAULT_BY_ID,
  SCREEN_ORDER,
  conditionFromFaults,
  isFaultId,
} from "./condition.ts";
import { addFaultSources, applyCameraFloor, type CameraFloor, type FaultSources } from "./gradeiqMap.ts";

export const CERT_ROWS = ["screen", "body", "liquid"] as const;
export type CertRow = (typeof CERT_ROWS)[number];

export const CERT_ROW_LABEL: Readonly<Record<CertRow, string>> = { screen: "Screen", body: "Body", liquid: "Liquid indicator" };

type Choice = {
  value: string;
  /** The chip's word. */
  label: string;
  /** What it means, for the report: "no lines, spots or dead pixels". */
  words: string;
  faults: FaultId[];
  screen?: ScreenState;
  body?: BodyState;
  /** The display test, read off the screen row. */
  display?: "pass" | "fail";
};

const CHOICES: Readonly<Record<CertRow, readonly Choice[]>> = {
  screen: [
    { value: "ok", label: "OK", words: "no lines, spots, dead pixels or scratches", screen: "flawless", display: "pass", faults: [] },
    { value: "scratches", label: "Scratches", words: "scratches only; no lines, spots or dead pixels", screen: "scratched", display: "pass", faults: [] },
    { value: "lines", label: "Lines or spots", words: "lines, spots or dead pixels on the display", screen: "lines_or_spots", display: "fail", faults: ["display_lines"] },
    { value: "cracked", label: "Cracked", words: "cracked glass", screen: "cracked", faults: ["screen_cracked"] },
  ],
  body: [
    { value: "like_new", label: "Like new", words: "like new", body: "flawless", faults: [] },
    { value: "scuffs", label: "Scuffs", words: "light scuffs", body: "scuffed", faults: [] },
    { value: "dents", label: "Dents", words: "dents on the frame", body: "dented", faults: [] },
    { value: "back_cracked", label: "Back cracked", words: "back glass cracked", body: "back_cracked", faults: ["back_cracked"] },
    { value: "bent", label: "Bent", words: "bent or broken frame", body: "bent", faults: ["frame_damage"] },
  ],
  liquid: [
    { value: "clean", label: "Clean", words: "not tripped", faults: [] },
    { value: "tripped", label: "Tripped", words: "tripped — liquid damage", faults: ["water_damage"] },
    { value: "cant_see", label: "Can't see", words: "not visible, so not checked", faults: [] },
  ],
};

/** The chips a row offers, in order — what SwapUp Store shows, word for word. */
export function certChoices(row: CertRow): { value: string; label: string }[] {
  return CHOICES[row].map((c) => ({ value: c.value, label: c.label }));
}

export function certChoice(row: CertRow, value: string): Choice | null {
  return CHOICES[row].find((c) => c.value === value) ?? null;
}

export function isCertRow(v: unknown): v is CertRow {
  return typeof v === "string" && (CERT_ROWS as readonly string[]).includes(v);
}

/** One certified row, as the case keeps it (cases.certification). */
export type Certified = {
  value: string;
  label: string;
  /** The staff member's name (the tablet's PIN user) and id. */
  by: string;
  userId: string;
  at: string;
  /** The customer's phone was showing the test colours when this was tapped (phase "colours"). */
  withColours: boolean;
  testSessionId: string | null;
  /** Faults this row put on the case — the ones a changed tap takes off again. */
  added: FaultId[];
  /** Condition issues those faults added (the liquid one), removed with them. */
  addedIssues: IssueId[];
};

export type Certification = Partial<Record<CertRow, Certified>>;

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Whatever is stored → a Certification. A row that doesn't read is dropped, never guessed. */
export function readCertification(raw: unknown): Certification {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Certification = {};
  for (const row of CERT_ROWS) {
    const r = o[row] && typeof o[row] === "object" ? (o[row] as Record<string, unknown>) : null;
    const value = str(r?.value, 20);
    const choice = value ? certChoice(row, value) : null;
    const by = str(r?.by);
    const at = str(r?.at, 40);
    if (!r || !choice || !by || !at) continue;
    out[row] = {
      value: choice.value,
      label: choice.label,
      by,
      userId: str(r.userId) ?? "",
      at,
      withColours: r.withColours === true,
      testSessionId: str(r.testSessionId),
      added: Array.isArray(r.added) ? r.added.filter((f): f is FaultId => typeof f === "string" && isFaultId(f)) : [],
      addedIssues: Array.isArray(r.addedIssues) ? (r.addedIssues.filter((i) => typeof i === "string") as IssueId[]) : [],
    };
  }
  return out;
}

/* ─────────────────────────── which rows the card shows ─────────────────────────── */

/**
 * What the store camera left for a person to look at — every signal the SwapUp grade
 * (lib/domain/grading.ts) clears only with a certification, so the card asks exactly
 * what the grade still wants:
 *   final / lcdChecked  the cosmetic grade isn't final (PV1) / the sweep didn't check the screen
 *   lcdDoubt            the sweep failed the screen but isn't sure (IC1 "check the display by eye", PV11)
 *   conclusive          false: not conclusive (PV2) — both rows
 *   needsHumanReview    GradeIQ asks for a review (PV3) — both rows
 *   lowParts            parts a FINAL grade rated C/D (PV10): front → screen, back/frame → body
 *   suggestedBody       a cracked back or bent frame the camera saw that isn't on the case (PV4)
 */
export type CertifySignals = {
  final: boolean;
  lcdChecked: boolean;
  lcdDoubt?: boolean;
  conclusive?: boolean | null;
  needsHumanReview?: boolean;
  lowParts?: readonly string[];
  suggestedBody?: boolean;
};

/**
 * The camera's signals from what it recorded: the case's camera record (after Apply) or the
 * session's live evidence (before). `components` only from a FINAL grade; `faults` = the case's,
 * so a suggestion already on the case asks nothing.
 */
export function certifySignals(x: {
  final: boolean;
  lcd: { cameraChecked: boolean; verdict: string | null; confirmed?: boolean };
  conclusive: boolean | null;
  needsHumanReview: boolean;
  suggested: readonly { id: string }[];
  components?: readonly { id: string; grade: string | null }[] | null;
  faults: readonly string[];
}): CertifySignals {
  return {
    final: x.final,
    lcdChecked: x.lcd.cameraChecked,
    lcdDoubt: x.lcd.verdict === "fail" && x.lcd.confirmed !== true,
    conclusive: x.conclusive,
    needsHumanReview: x.needsHumanReview,
    lowParts: x.final ? (x.components ?? []).filter((c) => c.grade === "C" || c.grade === "D").map((c) => c.id) : [],
    suggestedBody: x.suggested.some((s) => (s.id === "back_cracked" || s.id === "frame_damage") && !x.faults.includes(s.id)),
  };
}

/**
 * The rows the advisor is asked for: the screen (the glass) and the body wherever
 * the camera left the grade something only a look can settle (CertifySignals); and,
 * on that same card, the liquid indicator (no camera sees it). The card is there
 * only when the camera couldn't decide (owner, 2026-10-17: "the advisor
 * certification card shown only when the camera can't decide"), so a phone the
 * camera graded in full is asked nothing — not even the liquid row.
 * `camera` null = no camera evidence at all.
 */
export function certifyNeeded(camera: CertifySignals | null): CertRow[] {
  const out: CertRow[] = [];
  const both = !camera || !camera.final || camera.conclusive === false || !!camera.needsHumanReview;
  const low = camera?.lowParts ?? [];
  if (both || !camera!.lcdChecked || !!camera!.lcdDoubt || low.includes("front")) out.push("screen");
  if (both || low.includes("back") || low.includes("frame") || !!camera!.suggestedBody) out.push("body");
  if (out.length) out.push("liquid");
  return out;
}

/* ─────────────────────────── one tap ─────────────────────────── */

export type CertifyState = {
  faults: FaultId[];
  sources: FaultSources;
  condition: ConditionAnswers | null;
  /** What the store camera confirmed on the case (camera_check.floor), or null. */
  cameraFloor: CameraFloor | null;
  certification: Certification;
};

export type CertifyInput = { row: CertRow; value: string; by: string; userId: string; at: string; withColours: boolean; testSessionId: string | null };

export type CertifyResult = {
  /** false: the same value was already certified — nothing changes. */
  changed: boolean;
  faults: FaultId[];
  sources: FaultSources;
  /**
   * null while the case has no condition yet (before Apply): a tap never invents the rest of a
   * condition nobody looked at. Apply folds the certification in (withCertification).
   */
  condition: ConditionAnswers | null;
  certification: Certification;
  faultsAdded: FaultId[];
  faultsRemoved: FaultId[];
};

const onlyAdvisor = (s: FaultSources[FaultId]) => !s || s.length === 0 || (s.length === 1 && s[0] === "advisor");
const impliedIssues = (faults: FaultId[]): IssueId[] => [...new Set(faults.flatMap((f) => FAULT_BY_ID[f].implies.issues ?? []))];
const worse = <T>(order: readonly T[], a: T, b: T): T => (order.indexOf(b) > order.indexOf(a) ? b : a);

/**
 * The certified screen and body put on a condition — then never better than the
 * faults allow, nor than the store camera confirmed. Apply uses it after merging
 * the tests in, so a certification made before Apply stands (certifyRow uses it
 * for one tap).
 */
export function withCertification(
  c: ConditionAnswers,
  cert: Partial<Record<CertRow, { value: string } | null | undefined>> | null | undefined,
  faults: FaultId[],
  cameraFloor: CameraFloor | null
): ConditionAnswers {
  let out: ConditionAnswers = { ...c, accessories: { ...c.accessories }, issues: [...c.issues] };
  const sc = cert?.screen ? certChoice("screen", cert.screen.value)?.screen : undefined;
  const bd = cert?.body ? certChoice("body", cert.body.value)?.body : undefined;
  if (sc) out.screen = sc;
  if (bd) out.body = bd;
  const floor = conditionFromFaults(faults, out);
  out = {
    ...out,
    powersOn: out.powersOn && floor.powersOn,
    calls: out.calls && floor.calls,
    screen: worse(SCREEN_ORDER, out.screen, floor.screen),
    body: worse(BODY_ORDER, out.body, floor.body),
    issues: [...new Set([...out.issues, ...floor.issues])].sort() as IssueId[],
  };
  return cameraFloor ? applyCameraFloor(out, cameraFloor) : out;
}

/** The tap → the case's faults, their sources, its condition and the certification. An unknown value is a 400 the caller words. */
export function certifyRow(s: CertifyState, i: CertifyInput): CertifyResult | { error: string } {
  const choice = certChoice(i.row, i.value);
  if (!choice) return { error: `Tap one of: ${CHOICES[i.row].map((c) => c.label).join(", ")}.` };
  const prev = s.certification[i.row];
  if (prev?.value === choice.value) {
    // The same tap again changes nothing — unless the phone is showing the colours now and wasn't then.
    const better = i.row === "screen" && i.withColours && !prev.withColours;
    const certification = better ? { ...s.certification, screen: { ...prev, by: i.by, userId: i.userId, at: i.at, withColours: true, testSessionId: i.testSessionId } } : s.certification;
    return { changed: better, faults: [...s.faults], sources: s.sources, condition: s.condition, certification, faultsAdded: [], faultsRemoved: [] };
  }

  // Off: what the earlier tap on this row put on the case, when nothing else found it.
  const removed = (prev?.added ?? []).filter((f) => !choice.faults.includes(f) && s.faults.includes(f) && onlyAdvisor(s.sources[f]));
  const kept = s.faults.filter((f) => !removed.includes(f));
  const add = choice.faults.filter((f) => !kept.includes(f));
  const faults = [...kept, ...add];
  // This row's faults: the new ones, and the earlier tap's that are still its own.
  const added = choice.faults.filter((f) => add.includes(f) || (prev?.added ?? []).includes(f));

  const sources: FaultSources = {};
  for (const [k, v] of Object.entries(s.sources)) if (!removed.includes(k as FaultId)) sources[k as FaultId] = [...(v ?? [])];
  const nextSources = addFaultSources(sources, add.map((id) => ({ id, source: "advisor" as const })));

  // Condition (only once the case has one): the issues the earlier tap brought go with its faults
  // (unless another fault still implies them); then the row's value, never better than the faults
  // allow nor than the store camera confirmed.
  let condition: ConditionAnswers | null = null;
  let ownIssues: IssueId[] = impliedIssues(added);
  if (s.condition) {
    const stillImplied = new Set(impliedIssues(faults));
    const dropIssues = (prev?.addedIssues ?? []).filter((x) => !stillImplied.has(x));
    const base: ConditionAnswers = { ...s.condition, issues: s.condition.issues.filter((x) => !dropIssues.includes(x)) };
    const before = new Set(base.issues);
    condition = withCertification(base, { [i.row]: { value: choice.value } }, faults, s.cameraFloor);
    ownIssues = impliedIssues(added).filter((x) => !before.has(x) || (prev?.addedIssues ?? []).includes(x));
  }

  return {
    changed: true,
    faults,
    sources: nextSources,
    condition,
    certification: {
      ...s.certification,
      [i.row]: {
        value: choice.value,
        label: choice.label,
        by: i.by,
        userId: i.userId,
        at: i.at,
        withColours: i.withColours,
        testSessionId: i.testSessionId,
        added,
        addedIssues: ownIssues,
      } satisfies Certified,
    },
    faultsAdded: add,
    faultsRemoved: removed,
  };
}

/* ─────────────────────────── in words ─────────────────────────── */

/** "Screen certified by Asha K.: no lines, spots, dead pixels or scratches, on the test colours…" — one plain line per row. */
export function certSentence(row: CertRow, c: Pick<Certified, "value" | "by" | "withColours">): string {
  const choice = certChoice(row, c.value);
  const words = choice?.words ?? c.value;
  if (row === "liquid" && c.value === "cant_see") return `Liquid indicator: ${c.by} couldn't see it.`;
  const colours = row === "screen" && c.withColours && (choice?.display ?? null) !== null ? ", on the test colours" : "";
  return `${CERT_ROW_LABEL[row]} certified by ${c.by}: ${words}${colours}.`;
}
