/**
 * PHONECHECK — a Phonecheck station's test of the phone, in SwapUp's language.
 *
 * Phonecheck is a cable-connected desktop station (Legacy cloud DB API,
 * `GetDeviceInfo`). A store that owns one can pull its record by IMEI, have it
 * pushed by webhook, or upload it (the JSON, or the report as a PDF / photo that
 * an AI reads). Every path ends here: one record → `readPhonecheck` → PcRecord →
 * `evidenceFromPhonecheck` → the same test ids SwapUp Check uses, so ONE grading
 * engine (lib/domain/grading.ts) reads both.
 *
 * The rules that carry the honesty of it (spec §3.4–3.5, and DeNovo's defects
 * against 3,227 real records):
 *   1. An IMEI is exactly 15 digits. A Wi-Fi-only Apple device puts its serial
 *      in IMEI; stripping the letters leaves a 6–8 digit "IMEI" — rejected.
 *   2. The test time is never read in the server's own zone. `UpdatedTimeStamp`
 *      carries its offset; the zone-less `DeviceUpdatedDate` needs PHONECHECK_TZ,
 *      and without it the time is null with a reason.
 *   3. The activation lock is `DeviceLock`, not `MDM`. "Device Lock" in the
 *      Failed list is a status, never a test failure.
 *   4. `Grade` is the tester's dropdown pick (gradePerformed is always "0") —
 *      kept verbatim, never used for grading.
 *   5. A group of Phonecheck names passes only when one passed and none failed or
 *      is pending. Anything less is UNTESTED — never a pass. The camera passes
 *      only with a front AND a rear pass.
 *   6. Phonecheck almost never reports the charging port (observed once in 3,227
 *      records). The data cable proves nothing about it.
 *
 * Pure functions only — no database, no network, no clock.
 */
import { batteryHealthResult, STORAGE_SIZES, type DeviceReport, type TestDetail, type TestResult, type TestResults } from "./diagnostics.ts";
import { readImei } from "./imei.ts";
import type { TestEvidence } from "./grading.ts";

/* ─────────────────────────── types ─────────────────────────── */

export type OnOff = "on" | "off";
/** One name from Phonecheck's Passed / Failed / Pending lists. "M-Microphone" → { name: "Microphone", manual: true }. */
export type PcName = { name: string; manual: boolean };
/** A Phonecheck test SwapUp has no test id for — shown verbatim; a failure is a provisional reason (PV6). */
export type PcOther = { name: string; result: "passed" | "failed" | "pending"; manual: boolean };

export type PcRecord = {
  /** A4Reports — Phonecheck's report number (9 digits in every observed record). Not the link key. */
  reportId: string | null;
  /** One Phonecheck check = one key: `a4:{reportId}`, else `imei:{imei}:{testedAt ?? DeviceUpdatedDate}`. */
  key: string;
  imei: string;
  imeiCheckDigit: "valid" | "invalid";
  imei2: string | null;
  imei2CheckDigit: "valid" | "invalid" | null;
  serial: string | null;
  make: string | null;
  model: string | null;
  /** Samsung's SM code (SM-S918B), which normaliseModelCode reads. */
  modelNo: string | null;
  colour: string | null;
  carrier: string | null;
  /** A STORAGE_SIZES label ("256GB", "1TB"); anything else (2TB, "abc") → null. */
  variant: string | null;
  /** ISO UTC, or null with `testedAtWhy`. */
  testedAt: string | null;
  testedAtWhy: string | null;
  /** DeviceUpdatedDate verbatim (zone-less) — only for the key when testedAt is unknown. */
  deviceUpdatedDate: string | null;
  working: "yes" | "no" | "pending" | null;
  passed: PcName[];
  failed: PcName[];
  pending: PcName[];
  batteryHealthPct: number | null;
  batteryCycles: number | null;
  /** The tester's dropdown pick, verbatim. NEVER used for grading. */
  testerGrade: string | null;
  /** The activation lock (iCloud / Google). */
  deviceLock: OnOff | null;
  rooted: OnOff | null;
  knox: OnOff | null;
  mdm: OnOff | null;
  erased: boolean | null;
  erasureType: string | null;
  /** Parts JSON `.Remarks`: "Genuine" / "Not Genuine" / anything else. null = no Parts data. */
  parts: "genuine" | "not_genuine" | "unknown" | null;
  station: string | null;
  tester: string | null;
  /** Staff view only — never on the public report. */
  links: { a4: string | null; erasure: string | null; dhr: string | null };
  /** Read from an uploaded PDF / photo by AI (readPcExtraction), not from Phonecheck's own JSON. */
  aiRead: boolean;
};

/* ─────────────────────────── reading fields (copied from DeNovo's pick()) ─────────────────────────── */

type O = Record<string, unknown>;
const isObj = (v: unknown): v is O => !!v && typeof v === "object" && !Array.isArray(v);
const flatKey = (k: string) => k.toLowerCase().replace(/[ _-]/g, "");

/**
 * Field-name-agnostic getter: Phonecheck payloads vary (PascalCase, snake,
 * spaces). Copied from denovo-refurb src/lib/phonecheck.ts:20-29, not imported.
 */
function pick(o: O, ...keys: string[]): unknown {
  const flat: O = {};
  for (const k of Object.keys(o)) flat[flatKey(k)] = o[k];
  for (const k of keys) {
    const v = flat[flatKey(k)];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const text = (v: unknown, max = 80): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const digitsOf = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "");

function onOff(v: unknown): OnOff | null {
  const s = text(v, 20)?.toLowerCase();
  if (s === "on" || s === "yes" || s === "true" || s === "enabled" || s === "locked") return "on";
  if (s === "off" || s === "no" || s === "false" || s === "disabled" || s === "unlocked") return "off";
  return null; // "NA", "", anything else
}

function yesNo(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = text(v, 20)?.toLowerCase();
  if (s === "yes" || s === "true" || s === "1") return true;
  if (s === "no" || s === "false" || s === "0") return false;
  return null;
}

/** Only a real https link; anything else is dropped. */
function link(v: unknown): string | null {
  const s = text(v, 400);
  return s && /^https:\/\/[^\s"<>]+$/i.test(s) ? s : null;
}

/** "Yes" / "No" / "Pending" → yes / no / pending. */
function working(v: unknown): PcRecord["working"] {
  const s = text(v, 20)?.toLowerCase();
  return s === "yes" || s === "no" || s === "pending" ? s : null;
}

/** BatteryHealthPercentage: 1–100 → the %; "0", "", "BH not supported" → null. Never OEMBatteryHealth (mostly "0"). */
export function readBatteryPct(v: unknown): number | null {
  const s = text(v, 20);
  if (s === null) return null;
  const n = Number(s.replace(/%$/, "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n);
}

function cycles(v: unknown): number | null {
  const s = text(v, 20);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : null;
}

/** "256GB" / "256 gb" / "1TB" → the STORAGE_SIZES label; anything else → null. */
export function pcVariant(v: unknown): string | null {
  const s = text(v, 20)?.toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  return STORAGE_SIZES.some(([label]) => label === s) ? s : null;
}

/** Parts is a JSON string `{"Remarks":"Genuine"|"Not Genuine"|…, "Data":[…]}` (or, defensively, the object). */
function parts(v: unknown): PcRecord["parts"] {
  let o: unknown = v;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(o)) return null;
  const r = text(pick(o, "Remarks"), 40)?.toLowerCase().replace(/[\s_-]+/g, " ");
  if (!r) return null;
  if (r === "genuine") return "genuine";
  if (r === "not genuine" || r === "non genuine") return "not_genuine";
  return "unknown";
}

/* ─────────────────────────── time ─────────────────────────── */

/** "+05:30" / "-0400" / "Z" → minutes east of UTC; anything else → null. */
export function readOffset(tz: string | null | undefined): number | null {
  if (typeof tz !== "string") return null;
  const s = tz.trim();
  if (/^z$/i.test(s)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 14 || min > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (h * 60 + min);
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** A wall-clock time at `offsetMin` → ISO UTC, or null when it isn't a real date and time. */
function toUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, offsetMin: number): string | null {
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s)
    return null;
  return new Date(local - offsetMin * 60_000).toISOString();
}

/**
 * When the phone was tested, in UTC. `UpdatedTimeStamp` carries its offset
 * ("2026-03-12T17:51:00.00+04:00" in every observed record). `DeviceUpdatedDate`
 * has none, so it is read only at the configured `tz` — never the server's own
 * zone (DeNovo defect 5 shifted a 13:51Z check to 22:51Z).
 */
export function testedAtOf(updatedTimeStamp: unknown, deviceUpdatedDate: unknown, tz: string | null | undefined): { at: string | null; why: string | null } {
  const parse = (v: unknown, fallbackOffset: number | null): string | null => {
    const s = text(v, 40);
    const m = s ? STAMP.exec(s) : null;
    if (!m) return null;
    const offset = m[8] ? readOffset(m[8]) : fallbackOffset;
    if (offset === null) return null;
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    return toUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Math.min(ms, 999), offset);
  };
  const stamped = parse(updatedTimeStamp, null);
  if (stamped) return { at: stamped, why: null };
  if (text(deviceUpdatedDate, 40) === null) return { at: null, why: "Phonecheck sent no test time." };
  const offset = readOffset(tz);
  if (offset === null)
    return { at: null, why: "Phonecheck's test time has no time zone." };
  const local = parse(deviceUpdatedDate, offset);
  return local ? { at: local, why: null } : { at: null, why: "Phonecheck's test time could not be read." };
}

/* ─────────────────────────── test lists ─────────────────────────── */

const MAX_NAMES = 200;

/**
 * A Passed / Failed / Pending list → names. Split on , ; | newline (DeNovo's
 * toList); a leading "M-" means the tester entered it by hand. De-duplicated
 * case-insensitively ("Battery Drain" repeats within one record); a name is
 * manual only when every copy of it was.
 */
export function readNames(v: unknown): PcName[] {
  const raw: string[] = Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? v.split(/[,;|\n]/)
      : [];
  const out = new Map<string, PcName>();
  for (const r of raw.slice(0, MAX_NAMES * 2)) {
    let name = r.trim();
    let manual = false;
    if (/^m-/i.test(name)) {
      manual = true;
      name = name.slice(2).trim();
    }
    name = name.slice(0, 80);
    if (!name) continue;
    const k = name.toLowerCase();
    const prev = out.get(k);
    if (prev) prev.manual = prev.manual && manual;
    else if (out.size < MAX_NAMES) out.set(k, { name, manual });
  }
  return [...out.values()];
}

/* ─────────────────────────── the record ─────────────────────────── */

export type PcRead = { ok: true; record: PcRecord } | { ok: false; reason: string };

/**
 * One Phonecheck device record → PcRecord, or why it can't be used.
 * `tz`: PHONECHECK_TZ (e.g. "+05:30"), used only when UpdatedTimeStamp is missing.
 * `aiRead`: the record came from readPcExtraction (an uploaded PDF / photo).
 */
export function readPhonecheck(raw: unknown, opts: { tz?: string | null; aiRead?: boolean } = {}): PcRead {
  if (!isObj(raw)) return { ok: false, reason: "That is not a Phonecheck device record." };
  const imeiDigits = digitsOf(pick(raw, "IMEI"));
  if (imeiDigits.length !== 15) {
    return {
      ok: false,
      reason: imeiDigits.length
        ? `Phonecheck's IMEI has ${imeiDigits.length} digits, not 15 — can't match it.`
        : "No IMEI in the Phonecheck record — can't match it.",
    };
  }
  const imeiRead = readImei(imeiDigits);
  if (!imeiRead.ok) return { ok: false, reason: imeiRead.reason };
  const imei2Digits = digitsOf(pick(raw, "IMEI2"));
  const imei2Read = imei2Digits.length === 15 && imei2Digits !== imeiDigits ? readImei(imei2Digits) : null;
  const imei2 = imei2Read && imei2Read.ok ? imei2Read : null;

  const reportId = text(pick(raw, "A4Reports"), 40);
  const deviceUpdatedDate = text(pick(raw, "DeviceUpdatedDate"), 40);
  const t = testedAtOf(pick(raw, "UpdatedTimeStamp"), deviceUpdatedDate, opts.tz ?? null);
  const key = reportId ? `a4:${reportId}` : `imei:${imeiRead.imei}:${t.at ?? deviceUpdatedDate ?? "undated"}`;

  return {
    ok: true,
    record: {
      reportId,
      key,
      imei: imeiRead.imei,
      imeiCheckDigit: imeiRead.checkDigit,
      imei2: imei2 ? imei2.imei : null,
      imei2CheckDigit: imei2 ? imei2.checkDigit : null,
      serial: text(pick(raw, "Serial")),
      make: text(pick(raw, "Make")),
      model: text(pick(raw, "Model")),
      modelNo: text(pick(raw, "ModelNo")),
      colour: text(pick(raw, "Color", "Colour")),
      carrier: text(pick(raw, "Carrier")),
      variant: pcVariant(pick(raw, "Memory")),
      testedAt: t.at,
      testedAtWhy: t.why,
      deviceUpdatedDate,
      working: working(pick(raw, "Working")),
      passed: readNames(pick(raw, "Passed")),
      failed: readNames(pick(raw, "Failed")),
      pending: readNames(pick(raw, "Pending")),
      batteryHealthPct: readBatteryPct(pick(raw, "BatteryHealthPercentage")),
      batteryCycles: cycles(pick(raw, "BatteryCycle")),
      testerGrade: text(pick(raw, "Grade"), 20),
      deviceLock: onOff(pick(raw, "DeviceLock")),
      rooted: onOff(pick(raw, "Rooted")),
      knox: onOff(pick(raw, "Knox")),
      mdm: onOff(pick(raw, "MDM")),
      erased: yesNo(pick(raw, "Erased")),
      erasureType: text(pick(raw, "Type")),
      parts: parts(pick(raw, "Parts")),
      station: text(pick(raw, "StationID")),
      tester: text(pick(raw, "TesterName")),
      links: { a4: link(pick(raw, "A4ReportLink")), erasure: link(pick(raw, "erasureReportLink")), dhr: link(pick(raw, "dhr_link")) },
      aiRead: opts.aiRead === true,
    },
  };
}

export const MAX_PC_RECORDS = 100;

/**
 * Whatever Phonecheck (or a person) sent → the device records in it. A bare
 * array, or `devices` / `data` / `result` / `master` / `deviceInfo` (the
 * wrapper key is not pinned — DeNovo unwraps several), or one object. At most 100.
 */
export function unwrapPhonecheck(body: unknown): unknown[] {
  if (Array.isArray(body)) return body.slice(0, MAX_PC_RECORDS);
  if (!isObj(body)) return [];
  // A record itself (it has an IMEI field) is never searched for a wrapper.
  if (pick(body, "IMEI") !== undefined) return [body];
  for (const k of ["devices", "data", "result", "master", "deviceInfo"]) {
    const v = pick(body, k);
    if (Array.isArray(v)) return v.slice(0, MAX_PC_RECORDS);
    if (isObj(v)) return [v];
  }
  return [body];
}

/** 404 / "No Data Found" — never tested on this account. Not a failure. */
export function isNoData(status: number, body: unknown): boolean {
  if (status === 404) return true;
  const msg = isObj(body) ? text(pick(body, "msg", "message"), 200) : typeof body === "string" ? body : null;
  return !!msg && /no data found/i.test(msg);
}

/**
 * Store a record or not (spec §3.6). One row per Phonecheck check, keyed on
 * `key`: a later copy of the same check replaces it only when its test time is
 * NEWER; an equal one (a webhook replay) or one with no time to compare is stale.
 */
export function phonecheckUpsert(existing: { testedAt: string | null } | null, incoming: { testedAt: string | null }): "insert" | "replace" | "stale" {
  if (!existing) return "insert";
  const next = incoming.testedAt ? Date.parse(incoming.testedAt) : NaN;
  if (!Number.isFinite(next)) return "stale";
  const prev = existing.testedAt ? Date.parse(existing.testedAt) : NaN;
  if (!Number.isFinite(prev)) return "replace";
  return next > prev ? "replace" : "stale";
}

/* ─────────────────────────── Phonecheck names → SwapUp test ids (§3.5) ─────────────────────────── */

/** Observed Phonecheck names per SwapUp plan id (all seen in DeNovo's 3,227 records). Camera is by side, below. */
export const PC_TEST_NAMES: Readonly<Record<string, readonly string[]>> = {
  touch: ["Digitizer N Pattern", "Digitizer"],
  multitouch: ["MultiTouch"],
  display: ["LCD", "Display"],
  mic: ["Microphone", "Front Microphone", "Video Microphone", "Bottom Mic Quality", "Front Mic Quality", "Rear Mic Quality"],
  speaker: ["Loud Speaker", "Loudspeaker Quality", "Loudspeaker Ringtone"],
  voice: ["Ear Speaker", "Earpiece", "Earpiece Quality", "Earpiece Ringtone"],
  flash: ["Flashlight"],
  faceid: ["Face ID", "Fingerprint Sensor", "True Depth"],
  vibration: ["Vibration"],
  buttons: [
    "Power Button",
    "Volume Up Button",
    "Volume Down Button",
    "Home Button",
    "Action Button",
    "Flip Switch",
    "Back Button",
    "Menu Button",
    "Camera Control",
    "Camera Control Button",
    "Camera Control Slide",
    "Camera Control Swipe",
  ],
  battery: ["Battery Drain", "Battery Warning"],
  // Observed once in 3,227 records. "Wireless Charging" is NOT the port.
  charging: ["Charging"],
  connectivity: ["WiFi", "GPS", "WiFi+GPS", "Network Connectivity", "Sim Reader", "Sim Reader Test"],
  bluetooth: ["Bluetooth"],
  nfc: ["NFC"],
  motion: ["Gyroscope", "Accelerometer", "Screen Rotation"],
  sensors: ["Proximity Sensor", "Light Sensor", "Barometer"],
};

export const PC_CAMERA_NAMES: Readonly<Record<"front" | "rear", readonly string[]>> = {
  front: ["Front Camera", "Front Camera Quality", "Front Camera Focus", "Front Video Camera"],
  rear: [
    "Rear Camera",
    "Rear Camera Quality",
    "Rear Camera Focus",
    "UltraWide Camera",
    "UltraWide Camera Quality",
    "Telephoto Camera",
    "Telephoto Camera Quality",
    "Rear Video Camera",
  ],
};

/** Statuses Phonecheck lists among its tests. Never a test failure: the lock comes from the DeviceLock field. */
export const PC_STATUS_ITEMS: readonly string[] = ["Device Lock", "MDM", "Knox", "Jailbreak/Root", "eSIM-only device", "Beta OS", "Grading"];

/** Cosmetic checks: a failure is held against what the case records (PV9), never a test failure. */
export const PC_COSMETIC_ITEMS: readonly string[] = ["Cosmetics", "Glass Condition", "Back Glass Condition", "Frame Condition", "Camera Lens Condition", "Secondary Glass Cracked"];

export const PC_METHOD = "Phonecheck station test";
export const PC_BATTERY_METHOD = "Phonecheck BatteryHealthPercentage";

type Kind = { kind: "test"; id: string } | { kind: "camera"; side: "front" | "rear" } | { kind: "status" } | { kind: "cosmetic" };
const NAME_KIND = new Map<string, Kind>();
for (const [id, names] of Object.entries(PC_TEST_NAMES)) for (const n of names) NAME_KIND.set(n.toLowerCase(), { kind: "test", id });
for (const side of ["front", "rear"] as const) for (const n of PC_CAMERA_NAMES[side]) NAME_KIND.set(n.toLowerCase(), { kind: "camera", side });
for (const n of PC_STATUS_ITEMS) NAME_KIND.set(n.toLowerCase(), { kind: "status" });
for (const n of PC_COSMETIC_ITEMS) NAME_KIND.set(n.toLowerCase(), { kind: "cosmetic" });

type Tally = { passed: PcName[]; failed: PcName[]; pending: PcName[] };
const blankTally = (): Tally => ({ passed: [], failed: [], pending: [] });

/** Every distinct name across the three lists, in list order (Failed, Pending, Passed). */
const namesIn = (t: Tally): string[] => [...new Set([...t.failed, ...t.pending, ...t.passed].map((n) => n.name))];

/**
 * A record's lists → SwapUp test results, plus what is not a SwapUp test.
 *
 * Per id: FAIL if any name failed; PASS only if one passed and none failed or
 * is pending; otherwise SKIP ("pending on Phonecheck"). No name for an id = no
 * result at all (Phonecheck didn't report it). `at` stamps every result.
 */
export function pcResults(record: Pick<PcRecord, "passed" | "failed" | "pending" | "batteryHealthPct">, at: string): {
  results: TestResults;
  other: PcOther[];
  cosmeticFails: string[];
} {
  const tests = new Map<string, Tally>();
  const camera: Record<"front" | "rear", Tally> = { front: blankTally(), rear: blankTally() };
  const other = new Map<string, PcOther>();
  const cosmeticFails: string[] = [];
  const RANK = { passed: 0, pending: 1, failed: 2 } as const;

  for (const list of ["failed", "pending", "passed"] as const) {
    for (const n of record[list]) {
      const k = NAME_KIND.get(n.name.toLowerCase());
      if (!k) {
        const prev = other.get(n.name.toLowerCase());
        if (!prev || RANK[list] > RANK[prev.result]) other.set(n.name.toLowerCase(), { name: n.name, result: list, manual: n.manual });
        continue;
      }
      if (k.kind === "status") continue;
      if (k.kind === "cosmetic") {
        if (list === "failed" && !cosmeticFails.includes(n.name)) cosmeticFails.push(n.name);
        continue;
      }
      const t = k.kind === "camera" ? camera[k.side] : (tests.get(k.id) ?? tests.set(k.id, blankTally()).get(k.id)!);
      t[list].push(n);
    }
  }

  const results: TestResults = {};
  const manualOf = (names: PcName[]) => names.some((n) => n.manual);
  const result = (outcome: TestResult["outcome"], detail: TestDetail): TestResult => ({ outcome, detail: { method: PC_METHOD, ...detail }, at });

  for (const id of Object.keys(PC_TEST_NAMES)) {
    const t = tests.get(id);
    if (!t) continue;
    const names = namesIn(t);
    if (t.failed.length) results[id] = result("fail", { names, manual: manualOf(t.failed) });
    else if (t.passed.length && !t.pending.length) results[id] = result("pass", { names, manual: manualOf(t.passed) });
    else results[id] = result("skip", { names, manual: false, pending: true, reason: "pending on Phonecheck" });
  }

  const f = camera.front;
  const r = camera.rear;
  const camNames = [...namesIn(f), ...namesIn(r)];
  if (camNames.length) {
    if (f.failed.length || r.failed.length) {
      const side = f.failed.length && r.failed.length ? "both" : f.failed.length ? "front" : "rear";
      results.camera = result("fail", { names: camNames, manual: manualOf([...f.failed, ...r.failed]), side });
    } else if (f.passed.length && r.passed.length && !f.pending.length && !r.pending.length) {
      results.camera = result("pass", { names: camNames, manual: manualOf([...f.passed, ...r.passed]) });
    } else {
      const pending = f.pending.length > 0 || r.pending.length > 0;
      const gaps: string[] = [];
      for (const [side, t] of [["front", f], ["rear", r]] as const) {
        if (t.pending.length) gaps.push(`${side} pending on Phonecheck`);
        else if (!t.passed.length) gaps.push(`${side} not tested`);
      }
      results.camera = result("skip", { names: camNames, manual: false, ...(pending ? { pending: true } : {}), reason: gaps.join("; ") });
    }
  }

  if (record.batteryHealthPct !== null) results.battery_health = batteryHealthResult(record.batteryHealthPct, at, PC_BATTERY_METHOD);

  return { results, other: [...other.values()], cosmeticFails };
}

/**
 * A record → the evidence the grading engine reads. `source`: fetched (pull or
 * webhook) or uploaded by staff. `fallbackAt` stamps the results when Phonecheck's
 * own test time is unknown (the time SwapUp received it).
 *
 * `workingNo` is Phonecheck's Working = No with an EMPTY Failed list — "not
 * working" without naming any test (CG4). Working = No beside a named failure
 * is graded from the failure itself.
 */
export function evidenceFromPhonecheck(record: PcRecord, source: "phonecheck" | "phonecheck_upload", fallbackAt: string): TestEvidence {
  const { results, other, cosmeticFails } = pcResults(record, record.testedAt ?? fallbackAt);
  return {
    source,
    results,
    at: record.testedAt,
    pc: { other, cosmeticFails, workingNo: record.working === "no" && record.failed.length === 0, aiRead: record.aiRead },
  };
}

/** What the grading engine reads off a record besides the tests. */
export function pcFacts(record: Pick<PcRecord, "parts" | "deviceLock">): { parts: PcRecord["parts"]; deviceLock: OnOff | null } {
  return { parts: record.parts, deviceLock: record.deviceLock };
}

/**
 * The record as a DeviceReport, so `matchModel` reads it like a phone's own
 * report: ModelNo is the Samsung SM code, and the storage label is turned back
 * into bytes that storageVariant maps to the same label. Never a customer claim:
 * the station read it off the phone by cable.
 */
export function pcDeviceReport(record: Pick<PcRecord, "make" | "model" | "modelNo" | "variant">): DeviceReport {
  const bytes = STORAGE_SIZES.find(([label]) => label === record.variant)?.[1] ?? null;
  return {
    brand: record.make,
    manufacturer: record.make,
    modelName: record.model,
    modelCode: record.modelNo,
    osVersion: null,
    totalDiskBytes: bytes,
    totalMemoryBytes: null,
    batteryLevelPct: null,
    isPhysicalDevice: true,
    appVersion: null,
  };
}

/* ─────────────────────────── an uploaded report (PDF / photo), read by AI ─────────────────────────── */

/**
 * Staff may upload the Phonecheck report itself — the A4 certificate as a PDF,
 * or a photo / screenshot of it. Gemini (the key and model GradeIQ uses:
 * GEMINI_API_KEY, GEMINI_MODEL default "gemini-2.5-flash") reads it into the
 * SAME field names Phonecheck's JSON uses, under a strict response schema, and
 * the result goes through `readPhonecheck` like any other record. Anything not
 * legible is null — never invented. It is always provisional (PV7 + PV12).
 */
export const PC_UPLOAD_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type PcUploadMime = (typeof PC_UPLOAD_MIMES)[number];
/** 8 MB: a phone photo or a multi-page A4 PDF, and well inside Gemini's 20 MB inline request once base64'd. */
export const PC_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/** What the file's first bytes say it is — the declared type is never trusted alone. */
function sniff(bytes: Uint8Array): PcUploadMime | null {
  const at = (i: number) => bytes[i];
  const ascii = (from: number, s: string) => [...s].every((c, i) => at(from + i) === c.charCodeAt(0));
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && ascii(1, "PNG") && at(4) === 0x0d && at(5) === 0x0a) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** An uploaded report file → its type, or a reason staff can act on. */
export function checkPcUpload(declaredMime: string | null | undefined, bytes: Uint8Array): { ok: true; mime: PcUploadMime } | { ok: false; reason: string } {
  if (!bytes.length) return { ok: false, reason: "The file is empty." };
  if (bytes.length > PC_UPLOAD_MAX_BYTES) return { ok: false, reason: `File is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is ${PC_UPLOAD_MAX_BYTES / 1048576} MB.` };
  const declared = (declaredMime ?? "").split(";")[0].trim().toLowerCase();
  const actual = sniff(bytes);
  if (!actual) return { ok: false, reason: "Upload a PDF, or a JPEG, PNG or WebP photo." };
  if (declared && declared !== actual && !(declared === "image/jpg" && actual === "image/jpeg"))
    return { ok: false, reason: `File says ${declared} but is ${actual} — upload the report itself.` };
  return { ok: true, mime: actual };
}

const S = (description: string) => ({ type: "STRING", nullable: true, description });
const LIST = (description: string) => ({ type: "ARRAY", nullable: true, items: { type: "STRING" }, description });

/** Gemini responseSchema (its OpenAPI subset). Every field nullable: unreadable → null. */
export const PC_EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    IMEI: S("IMEI 1, exactly as printed (15 digits). null if not legible."),
    IMEI2: S("IMEI 2 if printed. null otherwise."),
    Serial: S("Serial number."),
    Make: S("Manufacturer, e.g. Samsung, Apple."),
    Model: S("Model name, e.g. Galaxy S23 Ultra."),
    ModelNo: S("Model number, e.g. SM-S918B."),
    Memory: S("Storage, e.g. 256GB."),
    Color: S("Colour."),
    Carrier: S("Carrier."),
    Grade: S("The grade printed on the report, verbatim."),
    Working: { type: "STRING", format: "enum", nullable: true, enum: ["Yes", "No", "Pending"], description: "The overall Working result." },
    Passed: LIST("Every test listed as passed, verbatim. Keep a leading M- (manual) prefix."),
    Failed: LIST("Every test listed as failed, verbatim. Keep a leading M- prefix."),
    Pending: LIST("Every test listed as pending, verbatim."),
    BatteryHealthPercentage: { type: "INTEGER", nullable: true, description: "Battery health %, 1–100. null if not printed." },
    BatteryCycle: { type: "INTEGER", nullable: true, description: "Battery cycle count." },
    DeviceLock: { type: "STRING", format: "enum", nullable: true, enum: ["On", "Off"], description: "Device lock / activation lock / FMI." },
    MDM: { type: "STRING", format: "enum", nullable: true, enum: ["On", "Off"] },
    Knox: { type: "STRING", format: "enum", nullable: true, enum: ["On", "Off"] },
    Rooted: { type: "STRING", format: "enum", nullable: true, enum: ["On", "Off"], description: "Jailbreak / root." },
    Erased: { type: "STRING", format: "enum", nullable: true, enum: ["Yes", "No"] },
    Type: S("Erasure method, verbatim."),
    PartsRemarks: { type: "STRING", format: "enum", nullable: true, enum: ["Genuine", "Not Genuine", "Unknown"], description: "Parts / genuine-parts summary." },
    StationID: S("Station ID."),
    TesterName: S("Tester name."),
    A4Reports: S("The report number."),
    UpdatedTimeStamp: S("Test date and time WITH its time-zone offset, as ISO 8601. null if no offset is printed."),
    DeviceUpdatedDate: S("Test date and time as printed, YYYY-MM-DD HH:MM:SS, when no offset is printed."),
  },
} as const;

export const PC_EXTRACT_PROMPT = `You are reading a Phonecheck device test report (the A4 certificate, a PDF or a photo / screenshot of it) for a phone trade-in counter.
Return ONLY what is ACTUALLY LEGIBLE in the file, in the JSON schema given.

RULES:
- Never guess, infer or complete a value. If a field is not clearly readable, return null for it.
- Copy test names exactly as printed, one per list item, into Passed / Failed / Pending. Keep a leading "M-" (manual) prefix. Do not move a test between lists.
- IMEI is 15 digits; copy every digit as printed. If any digit is unclear, return null.
- Battery health is a percentage 1–100; return null if it is not printed or reads 0.
- Grade is copied verbatim; do not work one out.
- Do not output example or placeholder values.`;

/** The generateContent body for one uploaded file (the key goes in a header, never here). */
export function pcExtractRequest(mime: PcUploadMime, base64: string): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: PC_EXTRACT_PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: PC_EXTRACT_SCHEMA, temperature: 0, topP: 1, topK: 1 },
  };
}

const PLACEHOLDER = /^(n\/?a|null|none|unknown|not legible|illegible|-+|\?+)$/i;

/**
 * Gemini's generateContent response → a Phonecheck-shaped raw record for
 * `readPhonecheck(raw, { aiRead: true })`. Only the schema's fields survive;
 * placeholders ("N/A", "unknown", "-") are dropped; numbers out of range are
 * dropped; report links are never taken from an AI read.
 */
export function readPcExtraction(response: unknown): { ok: true; raw: Record<string, unknown> } | { ok: false; reason: string } {
  const r = isObj(response) ? response : {};
  const cand = Array.isArray(r.candidates) && isObj(r.candidates[0]) ? (r.candidates[0] as O) : null;
  const content = cand && isObj(cand.content) ? (cand.content as O) : null;
  const pieces = content && Array.isArray(content.parts) ? content.parts : [];
  const textPart = pieces.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
  if (!textPart.trim()) {
    const why = cand && typeof cand.finishReason === "string" ? ` (${cand.finishReason})` : "";
    return { ok: false, reason: `The AI read nothing${why} — upload a clearer photo or the PDF.` };
  }
  let out: unknown;
  try {
    out = JSON.parse(textPart);
  } catch {
    return { ok: false, reason: "AI reading unreadable — try again, or upload the JSON." };
  }
  if (!isObj(out)) return { ok: false, reason: "AI reading wasn't a record — try again, or upload the JSON." };

  const raw: Record<string, unknown> = {};
  const str = (k: string, max = 80) => {
    const s = text(out[k], max);
    if (s && !PLACEHOLDER.test(s)) raw[k] = s;
  };
  const oneOf = (k: string, allowed: string[]) => {
    const s = text(out[k], 20);
    const hit = s ? allowed.find((a) => a.toLowerCase() === s.toLowerCase()) : undefined;
    if (hit) raw[k] = hit;
  };
  const list = (k: string) => {
    const v = out[k];
    if (!Array.isArray(v)) return;
    const names = v.map((x) => text(x, 80)).filter((x): x is string => !!x && !PLACEHOLDER.test(x)).slice(0, MAX_NAMES);
    if (names.length) raw[k] = names;
  };
  for (const k of ["IMEI", "IMEI2", "Serial", "Make", "Model", "ModelNo", "Memory", "Color", "Carrier", "Type", "StationID", "TesterName", "A4Reports"]) str(k);
  str("Grade", 20);
  str("UpdatedTimeStamp", 40);
  str("DeviceUpdatedDate", 40);
  oneOf("Working", ["Yes", "No", "Pending"]);
  for (const k of ["DeviceLock", "MDM", "Knox", "Rooted"]) oneOf(k, ["On", "Off"]);
  oneOf("Erased", ["Yes", "No"]);
  for (const k of ["Passed", "Failed", "Pending"]) list(k);
  const bh = readBatteryPct(out.BatteryHealthPercentage);
  if (bh !== null) raw.BatteryHealthPercentage = String(bh);
  const bc = cycles(out.BatteryCycle);
  if (bc !== null) raw.BatteryCycle = String(bc);
  const remarks = text(out.PartsRemarks, 20);
  if (remarks && ["genuine", "not genuine", "unknown"].includes(remarks.toLowerCase())) raw.Parts = JSON.stringify({ Remarks: remarks });
  return { ok: true, raw };
}
