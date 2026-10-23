/**
 * THE DEVICE AT THE COUNTER — what is wrong with it, said two ways.
 *
 * A service centre speaks in FAULTS ("cracked screen, battery drains") because
 * that is what it repairs. A buyback partner prices CONDITION ("screen cracked,
 * battery issue, no charger, 14 months old"), because that is what it resells.
 * The same phone has to be described in both languages and they must not drift:
 * an advisor who records a cracked screen for the repair quote and "flawless"
 * for the trade-in quote has just overpaid the customer with the store's credit.
 *
 * So faults are the source of truth: each fault names the PART that fixes it
 * and the CONDITION it implies. The advisor confirms the condition answers, and
 * may make them worse (a scuffed frame no fault mentions) but `conditionFloor`
 * reports any answer that is better than the faults allow, so the UI can refuse.
 * A worse answer that IS a repairable defect (a cracked screen, a faulty speaker)
 * brings its fault with it (`faultsNamedByCondition`), so the repair quote and the
 * trade-in describe the same phone whichever list staff edited — and takes it back
 * when the answer is changed again (`withConditionFaults`).
 *
 * The condition dimensions follow the shape buyback partners in India price on
 * (switches on / calls / screen / body / functional issues / accessories / age).
 * The wording here is ours.
 */

export type PartId =
  | "display"
  | "battery"
  | "back_cover"
  | "charging_board"
  | "rear_camera"
  | "front_camera"
  | "speaker"
  | "mic"
  | "buttons"
  | "motherboard";

export const PART_LABEL: Record<PartId, string> = {
  display: "Display assembly",
  battery: "Battery",
  back_cover: "Back glass / cover",
  charging_board: "Charging port (sub-board)",
  rear_camera: "Rear camera",
  front_camera: "Front camera",
  speaker: "Speaker",
  mic: "Microphone",
  buttons: "Side keys",
  motherboard: "Main board",
};

export type ScreenState = "flawless" | "scratched" | "lines_or_spots" | "cracked" | "not_working";
export type BodyState = "flawless" | "scuffed" | "dented" | "back_cracked" | "bent";
export type IssueId =
  | "touch"
  | "battery"
  | "charging"
  | "rear_camera"
  | "front_camera"
  | "speaker"
  | "mic"
  | "wifi_bt"
  | "fingerprint"
  | "buttons"
  | "vibration"
  | "liquid";
export type AgeBand = "lt3m" | "3to11m" | "gt11m";

/** Worst last — the index IS the severity. */
export const SCREEN_ORDER: ScreenState[] = ["flawless", "scratched", "lines_or_spots", "cracked", "not_working"];
export const BODY_ORDER: BodyState[] = ["flawless", "scuffed", "dented", "back_cracked", "bent"];

export const SCREEN_LABEL: Record<ScreenState, string> = {
  flawless: "Flawless",
  scratched: "Visible scratches",
  lines_or_spots: "Lines, spots or dead pixels",
  cracked: "Cracked glass",
  not_working: "Display not working",
};
export const BODY_LABEL: Record<BodyState, string> = {
  flawless: "Flawless",
  scuffed: "Light scuffs",
  dented: "Dents on the frame",
  back_cracked: "Back glass cracked",
  bent: "Bent or broken frame",
};
/**
 * The few words a customer reads for each screen and body state (the answer's grade note and the
 * market line's "₹34,960 less ₹5,250 for back glass cracked"). "" = nothing to say.
 */
export const SCREEN_WORD: Record<ScreenState, string> = {
  flawless: "",
  scratched: "screen scratched",
  lines_or_spots: "screen lines or spots",
  cracked: "screen cracked",
  not_working: "screen not working",
};
export const BODY_WORD: Record<BodyState, string> = {
  flawless: "",
  scuffed: "light scuffs",
  dented: "dented frame",
  back_cracked: "back glass cracked",
  bent: "bent frame",
};
export const ISSUE_LABEL: Record<IssueId, string> = {
  touch: "Touch not responding",
  battery: "Battery drains / swollen",
  charging: "Charging problem",
  rear_camera: "Rear camera faulty",
  front_camera: "Front camera faulty",
  speaker: "Speaker faulty",
  mic: "Microphone faulty",
  wifi_bt: "Wi-Fi / Bluetooth faulty",
  fingerprint: "Fingerprint sensor faulty",
  buttons: "Buttons faulty",
  vibration: "Vibration faulty",
  liquid: "Signs of liquid damage",
};
export const AGE_LABEL: Record<AgeBand, string> = {
  lt3m: "Under 3 months",
  "3to11m": "3 – 11 months",
  gt11m: "Over 11 months",
};

export type ConditionAnswers = {
  powersOn: boolean;
  calls: boolean;
  screen: ScreenState;
  body: BodyState;
  issues: IssueId[];
  accessories: { charger: boolean; box: boolean; bill: boolean };
  age: AgeBand;
};

export type FaultId =
  | "screen_cracked"
  | "display_lines"
  | "touch_issue"
  | "battery_drain"
  | "battery_swollen"
  | "back_cracked"
  | "frame_damage"
  | "charging_issue"
  | "rear_camera"
  | "front_camera"
  | "speaker"
  | "mic"
  | "buttons"
  | "water_damage"
  | "no_power"
  | "no_network";

export type FaultDef = {
  id: FaultId;
  label: string;
  /** The part a service centre replaces. null = no fixed price; needs inspection. */
  part: PartId | null;
  /** Physical / liquid damage — excluded from a standard manufacturer warranty. */
  physicalDamage: boolean;
  /** What this fault means for the trade-in condition answers. */
  implies: { powersOn?: false; calls?: false; screen?: ScreenState; body?: BodyState; issues?: IssueId[] };
};

export const FAULTS: FaultDef[] = [
  { id: "screen_cracked", label: "Cracked screen", part: "display", physicalDamage: true, implies: { screen: "cracked" } },
  { id: "display_lines", label: "Lines / spots on display", part: "display", physicalDamage: false, implies: { screen: "lines_or_spots" } },
  { id: "touch_issue", label: "Touch not working", part: "display", physicalDamage: false, implies: { issues: ["touch"] } },
  { id: "battery_drain", label: "Battery drains fast", part: "battery", physicalDamage: false, implies: { issues: ["battery"] } },
  { id: "battery_swollen", label: "Battery swollen", part: "battery", physicalDamage: false, implies: { issues: ["battery"], body: "dented" } },
  { id: "back_cracked", label: "Back glass cracked", part: "back_cover", physicalDamage: true, implies: { body: "back_cracked" } },
  { id: "frame_damage", label: "Bent / broken frame", part: null, physicalDamage: true, implies: { body: "bent" } },
  { id: "charging_issue", label: "Not charging", part: "charging_board", physicalDamage: false, implies: { issues: ["charging"] } },
  { id: "rear_camera", label: "Rear camera faulty", part: "rear_camera", physicalDamage: false, implies: { issues: ["rear_camera"] } },
  { id: "front_camera", label: "Front camera faulty", part: "front_camera", physicalDamage: false, implies: { issues: ["front_camera"] } },
  { id: "speaker", label: "Speaker faulty", part: "speaker", physicalDamage: false, implies: { issues: ["speaker"] } },
  { id: "mic", label: "Microphone faulty", part: "mic", physicalDamage: false, implies: { issues: ["mic"] } },
  { id: "buttons", label: "Side keys faulty", part: "buttons", physicalDamage: false, implies: { issues: ["buttons"] } },
  { id: "water_damage", label: "Liquid damage", part: null, physicalDamage: true, implies: { issues: ["liquid"] } },
  { id: "no_power", label: "Does not switch on", part: null, physicalDamage: false, implies: { powersOn: false } },
  { id: "no_network", label: "No network / calls fail", part: null, physicalDamage: false, implies: { calls: false } },
];

export const FAULT_BY_ID: Record<FaultId, FaultDef> = Object.fromEntries(FAULTS.map((f) => [f.id, f])) as Record<
  FaultId,
  FaultDef
>;

export function isFaultId(s: string): s is FaultId {
  return s in FAULT_BY_ID;
}

export const HEALTHY: Omit<ConditionAnswers, "accessories" | "age"> = {
  powersOn: true,
  calls: true,
  screen: "flawless",
  body: "flawless",
  issues: [],
};

const worse = <T>(order: T[], a: T, b: T): T => (order.indexOf(b) > order.indexOf(a) ? b : a);

/**
 * The condition the faults alone imply — the BEST the trade-in may be declared.
 * Accessories and age are not faults; they are carried from `base`.
 */
export function conditionFromFaults(
  faults: FaultId[],
  base: Pick<ConditionAnswers, "accessories" | "age">
): ConditionAnswers {
  let a: ConditionAnswers = { ...HEALTHY, issues: [], accessories: { ...base.accessories }, age: base.age };
  for (const id of faults) a = applyImplication(a, FAULT_BY_ID[id].implies);
  return a;
}

function applyImplication(a: ConditionAnswers, imp: FaultDef["implies"]): ConditionAnswers {
  const issues = new Set(a.issues);
  for (const i of imp.issues ?? []) issues.add(i);
  return {
    ...a,
    powersOn: imp.powersOn === false ? false : a.powersOn,
    calls: imp.calls === false ? false : a.calls,
    screen: imp.screen ? worse(SCREEN_ORDER, a.screen, imp.screen) : a.screen,
    body: imp.body ? worse(BODY_ORDER, a.body, imp.body) : a.body,
    issues: [...issues].sort(),
  };
}

/**
 * Where the advisor's answers are BETTER than the recorded faults allow.
 * Each entry is a reason the trade-in quote would overpay. Worse-than-faults is
 * fine (a scuff no fault mentions); better-than-faults is not.
 */
export function conditionFloor(answers: ConditionAnswers, faults: FaultId[]): string[] {
  const floor = conditionFromFaults(faults, answers);
  const problems: string[] = [];
  if (floor.powersOn === false && answers.powersOn) problems.push("Recorded as switching on, but a fault says it does not.");
  if (floor.calls === false && answers.calls) problems.push("Recorded as making calls, but a fault says the network fails.");
  if (SCREEN_ORDER.indexOf(answers.screen) < SCREEN_ORDER.indexOf(floor.screen))
    problems.push(`Screen "${SCREEN_LABEL[answers.screen]}" — the faults mean at least "${SCREEN_LABEL[floor.screen]}".`);
  if (BODY_ORDER.indexOf(answers.body) < BODY_ORDER.indexOf(floor.body))
    problems.push(`Body "${BODY_LABEL[answers.body]}" — the faults mean at least "${BODY_LABEL[floor.body]}".`);
  for (const i of floor.issues)
    if (!answers.issues.includes(i)) problems.push(`"${ISSUE_LABEL[i]}" is a fault but not in the condition.`);
  return problems;
}

/**
 * THE CONDITION NAMES ITS FAULT. Staff edit the condition (owner, 2026-10-19: "edit only
 * conditions"), and a defect recorded there is one a repair fixes: a screen recorded "Cracked
 * glass" is a cracked screen to the repair side too, never "Nothing to repair". Each answer below
 * is the one fault whose only implication is that answer (`implies`), so adding the fault moves
 * nothing on the trade-in: the condition already said it. Looks only (scratches, scuffs, dents), a
 * bent frame, and what only a bench can price (no power, no calls, liquid) name no fault here.
 */
const SCREEN_FAULT: Partial<Record<ScreenState, FaultId>> = { lines_or_spots: "display_lines", cracked: "screen_cracked" };
const BODY_FAULT: Partial<Record<BodyState, FaultId>> = { back_cracked: "back_cracked" };
const ISSUE_FAULT: Partial<Record<IssueId, FaultId>> = {
  touch: "touch_issue",
  battery: "battery_drain",
  charging: "charging_issue",
  rear_camera: "rear_camera",
  front_camera: "front_camera",
  speaker: "speaker",
  mic: "mic",
  buttons: "buttons",
};

/**
 * The faults the condition records that the faults don't: each defect answer worse than the
 * faults imply, as its fault (SCREEN_FAULT / BODY_FAULT / ISSUE_FAULT), in that order. Empty when
 * every defect on the condition already comes from a fault.
 */
export function faultsNamedByCondition(answers: ConditionAnswers, faults: FaultId[]): FaultId[] {
  const floor = conditionFromFaults(faults, answers);
  const out: FaultId[] = [];
  const add = (f: FaultId | undefined) => {
    if (f && !faults.includes(f) && !out.includes(f)) out.push(f);
  };
  if (SCREEN_ORDER.indexOf(answers.screen) > SCREEN_ORDER.indexOf(floor.screen)) add(SCREEN_FAULT[answers.screen]);
  if (BODY_ORDER.indexOf(answers.body) > BODY_ORDER.indexOf(floor.body)) add(BODY_FAULT[answers.body]);
  for (const i of answers.issues) if (!floor.issues.includes(i)) add(ISSUE_FAULT[i]);
  return out;
}

/**
 * The case's faults after a condition edit: what the answers name (faultsNamedByCondition) is added.
 * `fromCondition` are the faults only an earlier condition edit named (fault source "condition",
 * gradeiqMap.ts faultsAfterConditionEdit): each stays while the answers still name it and goes when
 * they don't, so "Cracked glass" tapped by mistake is undone by tapping the right answer. Every other
 * fault stays — a condition edit never removes what staff, a test or the camera recorded. The same
 * array back when nothing moves.
 */
export function withConditionFaults(faults: FaultId[], answers: ConditionAnswers, fromCondition: readonly FaultId[] = []): FaultId[] {
  const standing = fromCondition.length ? faults.filter((f) => !fromCondition.includes(f)) : faults;
  const named = faultsNamedByCondition(answers, standing);
  const next = [...faults.filter((f) => standing.includes(f) || named.includes(f)), ...named.filter((f) => !faults.includes(f))];
  return next.length === faults.length && next.every((f, i) => f === faults[i]) ? faults : next;
}

/**
 * The same device after the service centre's repair — used to ask the buyback
 * partner what the phone would be worth REPAIRED. Healing is per FAULT: only
 * what each repaired fault implied is undone; everything else the advisor
 * recorded (scuffs no fault explains, age, a missing charger) stays.
 *
 * A cracked back glass heals to "flawless": the SwapUp grade never saw a look
 * under it (marketSell.ts tradeInGrade prices it as flawless less the back-glass
 * %), and the new glass is exactly what the grade left out — so the repaired
 * phone is the grade it was shown and priced at (owner, 2026-10-22: one grade).
 * A bent or broken frame heals only as far as "scuffed": a new frame sits on an
 * otherwise original phone and we do not know the rest of it is flawless.
 */
export function healedCondition(answers: ConditionAnswers, repairedFaults: FaultId[]): ConditionAnswers {
  const out: ConditionAnswers = { ...answers, accessories: { ...answers.accessories } };
  const issues = new Set(answers.issues);
  for (const id of repairedFaults) {
    const imp = FAULT_BY_ID[id].implies;
    if (imp.powersOn === false) out.powersOn = true;
    if (imp.calls === false) out.calls = true;
    if (imp.screen) out.screen = "flawless";
    if (imp.body && BODY_ORDER.indexOf(out.body) >= BODY_ORDER.indexOf(imp.body)) {
      // only heal damage this fault explains; a worse state came from somewhere else
      if (out.body === imp.body) out.body = imp.body === "back_cracked" ? "flawless" : "scuffed";
    }
    for (const i of imp.issues ?? []) issues.delete(i);
  }
  out.issues = [...issues].sort();
  return out;
}

/** The parts a set of faults needs, de-duplicated (one display fixes crack + lines + touch). */
export function partsForFaults(faults: FaultId[]): { parts: PartId[]; inspectionFaults: FaultId[] } {
  const parts = new Set<PartId>();
  const inspection: FaultId[] = [];
  for (const id of faults) {
    const p = FAULT_BY_ID[id].part;
    if (p) parts.add(p);
    else inspection.push(id);
  }
  return { parts: [...parts], inspectionFaults: inspection };
}
