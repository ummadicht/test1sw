/**
 * Counter vocabulary shared by the desk, the case workspace, the receipt and
 * the tag. Pure — safe in server and client components alike (no lib/server).
 */
import {
  FAULT_BY_ID,
  SCREEN_ORDER,
  BODY_ORDER,
  SCREEN_LABEL,
  BODY_LABEL,
  ISSUE_LABEL,
  AGE_LABEL,
  conditionFromFaults,
  type ConditionAnswers,
  type FaultId,
} from "@/lib/domain/condition";

export type RecommendationId = "repair" | "upgrade" | "either" | "no_repair" | "cannot_say";

export const RECOMMENDATION: Record<RecommendationId, { label: string; pill: string }> = {
  repair: { label: "Repair", pill: "pill-fix" },
  upgrade: { label: "Upgrade", pill: "pill-up" },
  either: { label: "Close call", pill: "" },
  no_repair: { label: "Straight trade-in", pill: "" },
  cannot_say: { label: "Not enough to compare", pill: "" },
};

export function recommendationOf(r: string | null | undefined): { label: string; pill: string } | null {
  if (!r) return null;
  return RECOMMENDATION[r as RecommendationId] ?? { label: r, pill: "" };
}

export const ID_TYPES: { id: string; label: string }[] = [
  { id: "aadhaar", label: "Aadhaar card" },
  { id: "pan", label: "PAN card" },
  { id: "driving_licence", label: "Driving licence" },
  { id: "voter_id", label: "Voter ID" },
  { id: "passport", label: "Passport" },
];

export function idTypeLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return ID_TYPES.find((t) => t.id === id)?.label ?? id;
}

export const COVER_LABEL: Record<"none" | "warranty" | "care_plus", string> = {
  none: "No cover",
  warranty: "Manufacturer warranty",
  care_plus: "Samsung Care+ plan",
};

/** 98•••••345 — enough to recognise the customer's number, not enough to call it. */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone || "").replace(/\D/g, "");
  if (d.length < 6) return d || "—";
  return d.slice(0, 2) + "•".repeat(d.length - 5) + d.slice(-3);
}

/** How the counter groups the fault list — the order an advisor asks about a phone. */
export const FAULT_GROUPS: { title: string; faults: FaultId[] }[] = [
  { title: "Display", faults: ["screen_cracked", "display_lines", "touch_issue"] },
  { title: "Battery & power", faults: ["battery_drain", "battery_swollen", "charging_issue", "no_power"] },
  { title: "Body", faults: ["back_cracked", "frame_damage", "buttons"] },
  { title: "Cameras & audio", faults: ["rear_camera", "front_camera", "speaker", "mic"] },
  { title: "Other", faults: ["water_damage", "no_network"] },
];

export function faultLabels(faults: FaultId[]): string {
  return faults.map((f) => FAULT_BY_ID[f]?.label ?? f).join(", ");
}

/** "Cracked glass screen · Light scuffs · no box · over 11 months" — the declared condition in one line. */
export function conditionSummary(c: ConditionAnswers | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (!c.powersOn) out.push("Does not switch on");
  if (c.powersOn && !c.calls) out.push("Calls / network not working");
  out.push(`Screen: ${SCREEN_LABEL[c.screen]}`);
  out.push(`Body: ${BODY_LABEL[c.body]}`);
  if (c.issues.length) out.push(`Issues: ${c.issues.map((i) => ISSUE_LABEL[i]).join(", ")}`);
  const acc = [c.accessories.charger && "charger", c.accessories.box && "box", c.accessories.bill && "bill"].filter(Boolean);
  out.push(acc.length ? `With ${acc.join(", ")}` : "No charger, box or bill");
  out.push(`Age: ${AGE_LABEL[c.age]}`);
  return out;
}

const worse = <T,>(order: T[], a: T, b: T): T => (order.indexOf(b) > order.indexOf(a) ? b : a);

/**
 * When the faults change, carry the condition answers along:
 *  • anything a REMOVED fault had forced (and the advisor had not made worse)
 *    goes back to what the remaining faults imply — undoing a mis-tap undoes it;
 *  • anything an ADDED fault implies is pulled in, never made better.
 * Answers no fault explains (a scuff, a missing charger, age) are left alone.
 */
export function reconcileCondition(cond: ConditionAnswers, before: FaultId[], after: FaultId[]): ConditionAnswers {
  const oldFloor = conditionFromFaults(before, cond);
  const newFloor = conditionFromFaults(after, cond);
  const screen = cond.screen === oldFloor.screen && oldFloor.screen !== newFloor.screen ? newFloor.screen : worse(SCREEN_ORDER, cond.screen, newFloor.screen);
  const body = cond.body === oldFloor.body && oldFloor.body !== newFloor.body ? newFloor.body : worse(BODY_ORDER, cond.body, newFloor.body);
  const issues = new Set(cond.issues);
  for (const i of oldFloor.issues) if (!newFloor.issues.includes(i)) issues.delete(i);
  for (const i of newFloor.issues) issues.add(i);
  const powersOn = newFloor.powersOn === false ? false : oldFloor.powersOn === false && !cond.powersOn ? true : cond.powersOn;
  const calls = newFloor.calls === false ? false : oldFloor.calls === false && !cond.calls ? true : cond.calls;
  return { ...cond, powersOn, calls, screen, body, issues: [...issues].sort() as ConditionAnswers["issues"], accessories: { ...cond.accessories } };
}

/** Pull every answer that is better than the faults allow down to the floor. */
export function alignToFloor(cond: ConditionAnswers, faults: FaultId[]): ConditionAnswers {
  const floor = conditionFromFaults(faults, cond);
  const issues = new Set([...cond.issues, ...floor.issues]);
  return {
    ...cond,
    powersOn: floor.powersOn === false ? false : cond.powersOn,
    calls: floor.calls === false ? false : cond.calls,
    screen: worse(SCREEN_ORDER, cond.screen, floor.screen),
    body: worse(BODY_ORDER, cond.body, floor.body),
    issues: [...issues].sort() as ConditionAnswers["issues"],
    accessories: { ...cond.accessories },
  };
}

/**
 * Dates on the counter screens, receipt and tag. Fixed to India time so the
 * server render, the browser and the printed receipt all say the same thing.
 * (Use this rather than ui.tsx's fmtDate in SERVER components — a function
 * exported from a "use client" module cannot be called on the server.)
 */
export function fmtWhen(iso: string | null | undefined, style: "datetime" | "date" | "long" = "datetime"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { day: "numeric", month: "short", year: "numeric" }
      : style === "long"
        ? { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }
        : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
}

/** Galaxy series in the order the counter shows them. */
export const SERIES_ORDER = ["S", "Z", "A", "M", "F"];
export function seriesHeading(series: string): string {
  return /^[A-Z]$/.test(series) ? `Galaxy ${series}` : series;
}
