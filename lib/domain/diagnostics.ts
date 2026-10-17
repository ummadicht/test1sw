/**
 * SWAPUP CHECK — what the customer's own phone says about itself, in SwapUp's
 * language.
 *
 * The customer runs hardware tests on the phone they are trading in (SwapUp
 * Check, an Android app). Every result reaches the server; this module turns
 * them into what the counter needs: which trade-in model and storage it is,
 * which SwapUp faults (lib/domain/condition.ts) the failures mean, and what was
 * NOT tested.
 *
 * Two rules carry the honesty of the whole feature:
 *   1. A skipped or unsupported test is UNTESTED — never a pass. A critical
 *      test left untested makes the verdict "incomplete", whatever else passed.
 *   2. The model is matched only on the Samsung model code the phone reports
 *      (Build.MODEL, e.g. "SM-S901E"). No code match → match "none"; the
 *      advisor chooses the model. We never guess from a marketing name.
 *
 * Pure functions only — no database, no clock (callers pass `now`).
 */
import { type FaultId, type ConditionAnswers, type IssueId, FAULTS, ISSUE_LABEL, SCREEN_ORDER, BODY_ORDER, conditionFromFaults } from "./condition.ts";
import { readImei } from "./imei.ts";
import { indianMobile } from "./phone.ts";

/* ─────────────────────────── types ─────────────────────────── */

export type TestOutcome = "pass" | "fail" | "skip" | "unsupported";
export const OUTCOMES: readonly TestOutcome[] = ["pass", "fail", "skip", "unsupported"];

export type PlanItem = { id: string; name: string; critical: boolean };
export type TestDetail = Record<string, unknown>;
export type TestResult = { outcome: TestOutcome; detail: TestDetail | null; at: string };
export type TestResults = Record<string, TestResult>;

/** The model a customer chose on their own phone when SwapUp couldn't recognise it — a CLAIM, never a match. */
export type PickedModel = {
  modelId: string;
  variant: string | null;
  /** "Samsung Galaxy A54" — filled in by the server from its own model list, so staff can read the pick. */
  label?: string | null;
};

/**
 * What the customer says about things a phone cannot test on itself. null = not answered.
 *
 * The optional fields come from SwapUp Check ≥ 0.6.0's Identify step
 * (docs/PHONE-LED-FLOW.md). They are present only when the app sent them, so an
 * older app's declaration is stored exactly as it always was.
 */
export type Declared = {
  screenCracked: boolean | null;
  backCracked: boolean | null;
  liquid: boolean | null;
  imei: string | null;
  /** The second IMEI on a two-SIM phone (*#06# shows both). */
  imei2?: string | null;
  /** "Yes, that's my phone" (true) / "No — choose my phone" (false) on the identity card. */
  identityConfirmed?: boolean | null;
  picked?: PickedModel | null;
  /** A customer who started the trade-in alone (the store's counter code) gives their own name and number. */
  customerName?: string | null;
  customerPhone?: string | null;
};

/** The phone's own description of itself, as stored on the session. */
export type DeviceReport = {
  brand: string | null;
  manufacturer: string | null;
  /** Android Build.MODEL — on a Samsung this IS the model code, e.g. "SM-S901E". */
  modelName: string | null;
  modelCode: string | null;
  osVersion: string | null;
  totalDiskBytes: number | null;
  totalMemoryBytes: number | null;
  batteryLevelPct: number | null;
  isPhysicalDevice: boolean | null;
  appVersion: string | null;
};

/** The slice of a trade model the matcher needs. */
export type TradeModelRef = { id: string; brand: string; model: string; variants: string[]; modelCodes: string[] };

export type ModelMatch = {
  modelId: string | null;
  label: string | null;
  variant: string | null;
  match: "exact" | "family" | "none";
  why: string;
};

export type DiagnosticSummary = {
  model: ModelMatch;
  /** sources: where the fault came from — the phone's own test, or the customer's answer (both possible). */
  faults: { id: FaultId; because: string; sources: ("tested" | "declared" | "camera_ai")[] }[];
  untested: { id: string; name: string; critical: boolean }[];
  notes: string[];
  verdict: "all_passed" | "faults_found" | "incomplete";
};

/* ─────────────────────────── the plan ─────────────────────────── */

/**
 * The tests SwapUp Check runs, in order. Ids and names match the app's catalog
 * (swapup-mobile src/diagnostics/catalog.ts). Critical = a test whose failure
 * changes the repair quote or the trade-in price, so it must not be missing.
 */
export const DEFAULT_PLAN: readonly PlanItem[] = [
  { id: "touch", name: "Touchscreen", critical: true },
  { id: "multitouch", name: "Multi-touch", critical: false },
  { id: "display", name: "Display / dead pixels", critical: true },
  { id: "motion", name: "Gyroscope / accelerometer", critical: false },
  { id: "mic", name: "Microphone", critical: true },
  { id: "speaker", name: "Speaker", critical: true },
  { id: "voice", name: "Earpiece", critical: false },
  { id: "camera", name: "Cameras (front + rear)", critical: true },
  { id: "flash", name: "Flashlight", critical: false },
  { id: "faceid", name: "Biometrics", critical: false },
  { id: "vibration", name: "Vibration motor", critical: false },
  { id: "buttons", name: "Hardware buttons", critical: false },
  { id: "battery", name: "Battery", critical: false },
  // Not a test the phone runs: GradeIQ reads the % off a screenshot of the
  // phone's own battery-health screen (POST /api/device/battery). SwapUp Check
  // ≥ 0.6.0 only — an older app's plan has it taken out at join (planForApp).
  { id: "battery_health", name: "Battery health", critical: false },
  { id: "charging", name: "Charging port", critical: true },
  { id: "connectivity", name: "Wi-Fi / cellular / GPS", critical: false },
  { id: "sensors", name: "Compass / light / barometer", critical: false },
  { id: "bluetooth", name: "Bluetooth", critical: false },
  { id: "nfc", name: "NFC", critical: false },
];

/* ─────────────────────────── test → fault mapping ─────────────────────────── */

/** A failed test that IS a SwapUp fault (camera is handled by side, below). */
const FAIL_FAULT: Record<string, FaultId> = {
  touch: "touch_issue",
  multitouch: "touch_issue",
  display: "display_lines",
  mic: "mic",
  speaker: "speaker",
  voice: "speaker",
  buttons: "buttons",
  charging: "charging_issue",
  battery: "battery_drain",
  battery_health: "battery_drain",
};

/* ─────────────────────────── battery health (a screenshot, read by GradeIQ) ─────────────────────────── */

export const BATTERY_HEALTH_ID = "battery_health";
/** Below this the battery is worn enough to price as "drains fast" (the owner's line, 2026-10-17). */
export const BATTERY_HEALTH_PASS_PCT = 80;
export const BATTERY_HEALTH_METHOD = "battery screenshot read by GradeIQ";

/**
 * GradeIQ's reading of a battery-health screenshot → the battery_health result.
 * Nothing legible (null, 0, out of range) is a SKIP — untested, never a pass:
 * a blurry screenshot must not read as a healthy battery.
 */
export function batteryHealthResult(pct: number | null | undefined, at: string): TestResult {
  const p = typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct) : null;
  if (p === null) return { outcome: "skip", detail: { healthPct: null, method: BATTERY_HEALTH_METHOD, reason: "the screenshot could not be read" }, at };
  return { outcome: p >= BATTERY_HEALTH_PASS_PCT ? "pass" : "fail", detail: { healthPct: p, method: BATTERY_HEALTH_METHOD }, at };
}

/**
 * A failed test that is NOT a SwapUp fault — only a note. Where the trade-in
 * condition has a matching issue, the note says which box to tick, because the
 * buyback partner does price it.
 */
const NOTE_ONLY: Record<string, IssueId | null> = {
  flash: null,
  faceid: "fingerprint",
  vibration: "vibration",
  sensors: null,
  motion: null,
  connectivity: "wifi_bt",
  bluetooth: "wifi_bt",
  nfc: null,
};

export type CameraSide = "front" | "rear" | "both";

/** detail.side from the camera test. "back" is accepted as the camera API's word for rear. */
export function cameraSide(detail: TestDetail | null | undefined): CameraSide | null {
  const raw = detail && typeof detail.side === "string" ? detail.side.trim().toLowerCase() : "";
  if (raw === "front") return "front";
  if (raw === "rear" || raw === "back") return "rear";
  if (raw === "both") return "both";
  return null;
}

/* ─────────────────────────── model + storage ─────────────────────────── */

/** Storage sizes phones are sold in. 16/32 GB exist so an old phone is never rounded UP into a 64 GB price. */
export const STORAGE_SIZES: readonly [string, number][] = [
  ["16GB", 16e9],
  ["32GB", 32e9],
  ["64GB", 64e9],
  ["128GB", 128e9],
  ["256GB", 256e9],
  ["512GB", 512e9],
  ["1TB", 1e12],
];

/**
 * The storage variant label for what the phone reports. A phone reports less
 * than it was sold as (the system takes a share), sometimes a little more
 * (binary vs decimal units), so: the smallest standard size that is at least
 * 85% of the reported bytes.
 */
export function storageVariant(totalDiskBytes: number | null | undefined): string | null {
  if (typeof totalDiskBytes !== "number" || !Number.isFinite(totalDiskBytes) || totalDiskBytes <= 0) return null;
  const need = 0.85 * totalDiskBytes;
  for (const [label, bytes] of STORAGE_SIZES) if (bytes >= need) return label;
  return null;
}

/** "sm-s901e/ds" → "SM-S901E". Anything that is not a Samsung model code → null. */
export function normaliseModelCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().split("/")[0].replace(/\s+/g, "");
  return /^SM-[A-Z0-9]{4,10}$/.test(s) ? s : null;
}

/** The family a code belongs to: "SM-S901E" and "SM-S901B" are both "SM-S901". */
export function codeFamily(code: string): string {
  return code.slice(0, 7);
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function matchModel(device: DeviceReport | null, tradeModels: TradeModelRef[]): ModelMatch {
  const none = (why: string): ModelMatch => ({ modelId: null, label: null, variant: null, match: "none", why });
  if (!device) return none("The phone has not connected yet.");

  const candidates = [device.modelCode, device.modelName].map(normaliseModelCode).filter((c): c is string => !!c);
  const codes = [...new Set(candidates)];
  const reported = [device.manufacturer || device.brand, device.modelName].filter(Boolean).join(" ").trim();
  if (!codes.length) {
    return none(
      reported
        ? `The phone reports "${reported}", which is not a Samsung model code. SwapUp matches phones by model code only — choose the model by hand.`
        : "The phone did not report its model. Choose the model by hand."
    );
  }

  const known = tradeModels.map((m) => ({ m, codes: (m.modelCodes || []).map(normaliseModelCode).filter((c): c is string => !!c) }));
  let found: { m: TradeModelRef; match: "exact" | "family"; code: string; via: string } | null = null;
  for (const level of ["exact", "family"] as const) {
    for (const code of codes) {
      const hits = known.filter((k) => (level === "exact" ? k.codes.includes(code) : k.codes.some((c) => codeFamily(c) === codeFamily(code))));
      const ids = [...new Set(hits.map((h) => h.m.id))];
      if (ids.length > 1) {
        return none(`Model code ${code} matches more than one model on file (${hits.map((h) => h.m.model).join(", ")}). Choose the model by hand.`);
      }
      if (ids.length === 1) {
        const via = level === "exact" ? code : hits[0].codes.find((c) => codeFamily(c) === codeFamily(code))!;
        found = { m: hits[0].m, match: level, code, via };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return none(`Model code ${codes[0]} is not in SwapUp's model list. Choose the model by hand.`);

  const { m } = found;
  const label = `${m.brand} ${m.model}`;
  const modelWhy =
    found.match === "exact"
      ? `Model code ${found.code} is the ${m.model}.`
      : `Model code ${found.code} is the same model family as ${found.via} (${m.model}) — a regional version of it.`;

  const size = storageVariant(device.totalDiskBytes);
  let variant: string | null = null;
  let storageWhy: string;
  if (size === null) {
    storageWhy = "The phone did not report its storage — choose the storage by hand.";
  } else if ((m.variants || []).includes(size)) {
    variant = size;
    storageWhy = `Storage reads ${gb(device.totalDiskBytes!)}, so ${size}.`;
  } else {
    storageWhy = `Storage reads ${gb(device.totalDiskBytes!)} (${size}), which is not a storage option on file for the ${m.model} — choose the storage by hand.`;
  }
  return { modelId: m.id, label, variant, match: found.match, why: `${modelWhy} ${storageWhy}` };
}

/* ─────────────────────────── the summary ─────────────────────────── */

/**
 * SwapUp Check also runs in a web browser (Expo web, /app/check/) — the only
 * way to test an iPhone, and the no-install way on Android. The browser build
 * reports its appVersion as "web-<version>". A browser cannot run every test
 * (which ones depends on the phone and the browser): those come in as
 * "unsupported" and stay UNTESTED like any other gap — this note only tells the
 * advisor why there are more of them.
 */
export const BROWSER_NOTE = "Tested in a web browser — some tests can't run in a browser; the SwapUp Check app covers more.";

/** The results came from the browser build of SwapUp Check (appVersion "web-…"), not the installed app. */
export function isBrowserReport(device: Pick<DeviceReport, "appVersion"> | null | undefined): boolean {
  return typeof device?.appVersion === "string" && device.appVersion.trim().toLowerCase().startsWith("web-");
}

const FAULT_ORDER: FaultId[] = FAULTS.map((f) => f.id);

/**
 * Everything the counter needs from one test session. See docs/MOBILE-API.md §6.
 *
 * verdict:
 *   incomplete    a critical test has no pass/fail result (skipped, unsupported, never run)
 *   faults_found  otherwise, when any test failed or the customer declared damage
 *   all_passed    otherwise — every test that ran passed (non-critical ones may still be listed as untested)
 */
export function summarise(
  plan: readonly PlanItem[],
  results: TestResults,
  declared: Declared | null,
  device: DeviceReport | null,
  tradeModels: TradeModelRef[],
  /** false for the native automatic app, which never asks the damage questions (the store camera covers cracks). */
  opts: { declaredExpected?: boolean } = {}
): DiagnosticSummary {
  const nameOf = new Map(plan.map((p) => [p.id, p.name]));
  const name = (id: string) => nameOf.get(id) ?? id;
  const reasons = new Map<FaultId, string[]>();
  const sources = new Map<FaultId, Set<"tested" | "declared" | "camera_ai">>();
  const add = (f: FaultId, why: string, source: "tested" | "declared" | "camera_ai" = "tested") => {
    const list = reasons.get(f) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(f, list);
    sources.set(f, (sources.get(f) ?? new Set()).add(source));
  };
  const notes: string[] = [];
  let anyFailed = false;

  // Plan order first, then anything extra the phone sent, so the output is stable.
  const ids = [...plan.map((p) => p.id), ...Object.keys(results).filter((id) => !nameOf.has(id)).sort()];
  for (const id of ids) {
    const r = results[id];
    if (!r || r.outcome !== "fail") continue;
    anyFailed = true;
    // A display fail that only the store camera found (folded in by
    // resultsWithCameraDisplay) is the camera's finding, not a failed phone test:
    // listed so the advisor sees it, with the camera as its source.
    const d = r.detail as Record<string, unknown> | null | undefined;
    if (id === "display" && d?.camera === "fail" && d?.selfTest !== "fail") {
      add("display_lines", "The store camera's screen sweep found a display fault", "camera_ai");
      continue;
    }
    const what = `${name(id)} test failed on the phone`;
    if (id === BATTERY_HEALTH_ID) {
      // Not a test the phone ran — the % its own battery screen showed.
      const pct = typeof d?.healthPct === "number" ? d.healthPct : null;
      add("battery_drain", pct === null ? `Battery health under ${BATTERY_HEALTH_PASS_PCT} % (screenshot)` : `Battery health ${pct} % (screenshot)`);
    } else if (id === "camera") {
      const side = cameraSide(r.detail);
      if (side === "rear" || side === "both") add("rear_camera", `${what} (rear camera)`);
      if (side === "front" || side === "both") add("front_camera", `${what} (front camera)`);
      if (!side) notes.push("The camera test failed but the app did not say which camera. Check both cameras and add the fault by hand.");
    } else if (FAIL_FAULT[id]) {
      add(FAIL_FAULT[id], what);
    } else if (id in NOTE_ONLY) {
      const issue = NOTE_ONLY[id];
      notes.push(
        issue
          ? `${name(id)} test failed. It is not a repair fault, but tick "${ISSUE_LABEL[issue]}" in the condition if it is faulty — the buyback partner prices it.`
          : `${name(id)} test failed. It does not change the repair quote or the trade-in price; tell the customer.`
      );
    } else {
      notes.push(`${name(id)} test failed. SwapUp has no fault for it — check it by hand.`);
    }
  }

  // What the customer says about damage a phone cannot see on itself. SwapUp
  // Check ≥ 0.6.0 declares its IMEI and identity answers with the damage answers
  // left empty — that is "not asked", not three unanswered questions.
  const damageSaid = !!declared && [declared.screenCracked, declared.backCracked, declared.liquid].some((v) => v === true || v === false);
  if (!damageSaid && opts.declaredExpected === false) {
    notes.push("The app doesn't ask the customer about damage: cracks and scratches come from the store camera check. Liquid damage can't be tested — check the liquid indicators by eye.");
  } else if (!declared) {
    notes.push("The customer has not answered the damage questions (cracked screen, cracked back, liquid). Check the phone by eye.");
  } else {
    const ask: [keyof Declared, FaultId, string, string][] = [
      ["screenCracked", "screen_cracked", "The customer says the screen is cracked", "whether the screen is cracked"],
      ["backCracked", "back_cracked", "The customer says the back glass is cracked", "whether the back glass is cracked"],
      ["liquid", "water_damage", "The customer says the phone has had liquid damage", "whether the phone has had liquid damage"],
    ];
    for (const [key, fault, yes, what] of ask) {
      if (declared[key] === true) add(fault, yes, "declared");
      else if (declared[key] === null || declared[key] === undefined) notes.push(`The customer did not say ${what} — check it by eye.`);
    }
  }

  // Untested: in the plan, but no pass/fail.
  const untested = plan
    .filter((p) => {
      const o = results[p.id]?.outcome;
      return o !== "pass" && o !== "fail";
    })
    .map((p) => ({ id: p.id, name: p.name, critical: p.critical }));

  if (isBrowserReport(device)) notes.push(BROWSER_NOTE);
  if (device && device.isPhysicalDevice === false) notes.push("These tests ran on an emulator, not a real phone. Do not use them for a trade-in.");

  const faults = [...reasons.entries()]
    .sort((a, b) => FAULT_ORDER.indexOf(a[0]) - FAULT_ORDER.indexOf(b[0]))
    .map(([id, why]) => ({ id, because: why.join("; "), sources: (["tested", "declared", "camera_ai"] as const).filter((x) => sources.get(id)?.has(x)) }));

  const verdict: DiagnosticSummary["verdict"] = untested.some((u) => u.critical)
    ? "incomplete"
    : faults.length || anyFailed
      ? "faults_found"
      : "all_passed";

  return { model: matchModel(device, tradeModels), faults, untested, notes, verdict };
}

/** Plan tests with any result in (a skip counts — the app moved past it). */
export function progressOf(plan: readonly PlanItem[], results: TestResults): { done: number; total: number } {
  return { done: plan.filter((p) => !!results[p.id]).length, total: plan.length };
}

/* ─────────────────────────── applying to the case ─────────────────────────── */

const DEFAULT_BASE: Pick<ConditionAnswers, "accessories" | "age"> = { accessories: { charger: true, box: false, bill: false }, age: "gt11m" };

/**
 * The condition after adding the tested faults. Never BETTER than what the
 * advisor already recorded: every dimension takes the worse of the two, so a
 * scuff the advisor saw survives. Accessories and age stay the advisor's.
 */
export function mergeCondition(prev: ConditionAnswers | null, faults: FaultId[]): ConditionAnswers {
  const floor = conditionFromFaults(faults, prev ?? DEFAULT_BASE);
  if (!prev) return floor;
  const worse = <T>(order: T[], a: T, b: T): T => (order.indexOf(b) > order.indexOf(a) ? b : a);
  return {
    powersOn: prev.powersOn && floor.powersOn,
    calls: prev.calls && floor.calls,
    screen: worse(SCREEN_ORDER, prev.screen, floor.screen),
    body: worse(BODY_ORDER, prev.body, floor.body),
    issues: [...new Set([...prev.issues, ...floor.issues])].sort() as IssueId[],
    accessories: { ...prev.accessories },
    age: prev.age,
  };
}

/** Existing case faults plus the tested ones, de-duplicated, existing first. */
export function unionFaults(existing: FaultId[], tested: FaultId[]): FaultId[] {
  return [...new Set([...existing, ...tested])];
}

/* ─────────────────────────── reading what the phone sends ─────────────────────────── */

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

/** What a person typed or a QR carried → the code, or null. Case, spaces and dashes are forgiven. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, "");
  return CODE_RE.test(s) ? s : null;
}

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Whatever the app sent as `device` → a DeviceReport. Unknown fields are dropped; nothing is invented. */
export function readDevice(raw: unknown, appVersion?: unknown): DeviceReport {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pct = num(d.batteryLevelPct);
  return {
    brand: str(d.brand),
    manufacturer: str(d.manufacturer),
    modelName: str(d.modelName),
    // expo-device calls it modelId (null on Android, where modelName carries the code).
    modelCode: str(d.modelCode) ?? str(d.modelId),
    osVersion: str(d.osVersion, 40),
    totalDiskBytes: num(d.totalDiskBytes),
    totalMemoryBytes: num(d.totalMemoryBytes),
    batteryLevelPct: pct === null ? null : Math.min(100, Math.round(pct)),
    isPhysicalDevice: typeof d.isPhysicalDevice === "boolean" ? d.isPhysicalDevice : null,
    appVersion: str(appVersion, 40) ?? str(d.appVersion, 40),
  };
}

const MAX_DETAIL_CHARS = 2000;

export type ResultItem = { testId: string; outcome: TestOutcome; detail: TestDetail | null; at: string };

/**
 * A results batch → the items to keep and the test ids ignored (not in the
 * plan, or malformed). Never throws on one bad item: the app retries its queue
 * until acknowledged, and one bad item must not block the rest forever.
 * A missing or unreadable `at` is stamped with `now`.
 */
export function readResults(raw: unknown, plan: readonly PlanItem[], now: string): { items: ResultItem[]; ignored: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const planIds = new Set(plan.map((p) => p.id));
  const items: ResultItem[] = [];
  const ignored: string[] = [];
  for (const x of list.slice(0, 100)) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const testId = typeof o.testId === "string" ? o.testId.trim().slice(0, 40) : "";
    const outcome = o.outcome as TestOutcome;
    if (!testId || !planIds.has(testId) || !OUTCOMES.includes(outcome)) {
      ignored.push(testId || "(no testId)");
      continue;
    }
    let detail: TestDetail | null = null;
    if (o.detail && typeof o.detail === "object" && !Array.isArray(o.detail)) {
      const json = JSON.stringify(o.detail);
      detail = json.length <= MAX_DETAIL_CHARS ? (JSON.parse(json) as TestDetail) : { truncated: true };
    }
    const at = typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? new Date(Date.parse(o.at)).toISOString() : now;
    items.push({ testId, outcome, detail, at });
  }
  return { items, ignored };
}

/** Idempotent per testId: the result with the latest `at` wins (a tie takes the newer delivery). */
export function mergeResults(existing: TestResults, items: ResultItem[]): TestResults {
  const out: TestResults = { ...existing };
  for (const it of items) {
    const cur = out[it.testId];
    if (cur && Date.parse(cur.at) > Date.parse(it.at)) continue;
    out[it.testId] = { outcome: it.outcome, detail: it.detail, at: it.at };
  }
  return out;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
const TRADE_MODEL_ID = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The declaration → Declared, or an error a customer can act on.
 *
 * The 0.6.0 fields (imei2, identityConfirmed, picked, customerName,
 * customerPhone) appear in the result only when the body has the key, so an
 * older app's declaration is stored exactly as before. `picked` is checked for
 * shape here; the server checks the model is really on its list.
 */
export function readDeclared(raw: unknown): { ok: true; declared: Declared } | { ok: false; reason: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tri = (v: unknown): boolean | null | "bad" => (v === true || v === false ? v : v === null || v === undefined ? null : "bad");
  const screenCracked = tri(o.screenCracked);
  const backCracked = tri(o.backCracked);
  const liquid = tri(o.liquid);
  if (screenCracked === "bad" || backCracked === "bad" || liquid === "bad") return { ok: false, reason: "Answer each question with yes or no." };
  let imei: string | null = null;
  if (!blank(o.imei)) {
    const r = readImei(String(o.imei));
    if (!r.ok) return { ok: false, reason: "That IMEI does not look right. Dial *#06# and type the 15 digits shown under IMEI." };
    imei = r.imei;
  }
  const declared: Declared = { screenCracked, backCracked, liquid, imei };

  if ("imei2" in o) {
    declared.imei2 = null;
    if (!blank(o.imei2)) {
      const r = readImei(String(o.imei2));
      if (!r.ok) return { ok: false, reason: "That second IMEI does not look right. Dial *#06# and type the 15 digits shown under IMEI 2." };
      if (r.imei === imei) return { ok: false, reason: "The second IMEI is the same as the first — a two-SIM phone shows two different numbers." };
      declared.imei2 = r.imei;
    }
  }
  if ("identityConfirmed" in o) {
    const v = tri(o.identityConfirmed);
    if (v === "bad") return { ok: false, reason: "Say whether this is your phone." };
    declared.identityConfirmed = v;
  }
  if ("picked" in o) {
    const p = o.picked;
    if (p === null || p === undefined) declared.picked = null;
    else {
      const q = (typeof p === "object" ? p : {}) as Record<string, unknown>;
      const variant = q.variant === null || q.variant === undefined ? null : q.variant;
      if (typeof q.modelId !== "string" || !TRADE_MODEL_ID.test(q.modelId) || (variant !== null && (typeof variant !== "string" || !variant.trim() || variant.length > 20)))
        return { ok: false, reason: "Choose your phone from the list." };
      declared.picked = { modelId: q.modelId, variant: variant === null ? null : (variant as string).trim() };
    }
  }
  if ("customerName" in o) {
    if (!blank(o.customerName) && typeof o.customerName !== "string") return { ok: false, reason: "Type your name, or leave it empty." };
    declared.customerName = blank(o.customerName) ? null : String(o.customerName).trim().replace(/\s+/g, " ").slice(0, 80);
  }
  if ("customerPhone" in o) {
    declared.customerPhone = null;
    if (!blank(o.customerPhone)) {
      const m = indianMobile(typeof o.customerPhone === "string" ? o.customerPhone : String(o.customerPhone));
      if (!m) return { ok: false, reason: "Type a 10-digit mobile number, or leave it empty." };
      declared.customerPhone = m;
    }
  }
  return { ok: true, declared };
}

/* ─────────────────────────── store Wi-Fi ─────────────────────────── */

export type WifiSecurity = "WPA" | "WEP" | "nopass";
export type StoreWifi = { ssid: string; password: string; security: WifiSecurity; hidden: boolean };

/** Escape for the WIFI: QR payload — \ ; , : " are backslash-escaped. */
export function wifiEscape(s: string): string {
  return s.replace(/([\\;,:"])/g, "\\$1");
}

/** The standard Wi-Fi QR payload phones' cameras understand. */
export function wifiQr(w: StoreWifi): string {
  const parts = [`T:${w.security}`, `S:${wifiEscape(w.ssid)}`];
  if (w.security !== "nopass") parts.push(`P:${wifiEscape(w.password)}`);
  parts.push(`H:${w.hidden ? "true" : "false"}`);
  return `WIFI:${parts.join(";")};;`;
}

/** A manager's Wi-Fi form → StoreWifi, null (cleared), or a reason they can fix. */
export function readWifi(raw: unknown): { ok: true; wifi: StoreWifi | null } | { ok: false; reason: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ssid = typeof o.ssid === "string" ? o.ssid.trim() : "";
  if (!ssid) return { ok: true, wifi: null };
  if (new TextEncoder().encode(ssid).length > 32) return { ok: false, reason: "A Wi-Fi network name can be at most 32 characters." };
  const security = (o.security ?? "WPA") as WifiSecurity;
  if (!["WPA", "WEP", "nopass"].includes(security)) return { ok: false, reason: "Choose the Wi-Fi security: WPA/WPA2/WPA3, WEP or none." };
  const password = security === "nopass" ? "" : typeof o.password === "string" ? o.password : "";
  if (security === "WPA" && !(password.length >= 8 && password.length <= 63) && !/^[0-9a-fA-F]{64}$/.test(password))
    return { ok: false, reason: "A WPA Wi-Fi password is 8 to 63 characters. Type it exactly as the router shows it." };
  if (security === "WEP" && ![5, 13].includes(password.length) && !/^([0-9a-fA-F]{10}|[0-9a-fA-F]{26})$/.test(password))
    return { ok: false, reason: "A WEP key is 5 or 13 characters (or 10 or 26 hex digits)." };
  return { ok: true, wifi: { ssid, password, security, hidden: o.hidden === true } };
}
