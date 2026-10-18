/**
 * THE GRADE ON THE DESK — how the answer card, the grade report (public and
 * desk), the receipt and the pickup list read the server's grade. Pure, so it is
 * tested without a browser (gradingView.test.ts). Every grade, label and reason
 * is the server's (lib/domain/grading.ts, lib/domain/gradingReport.ts); this
 * file only picks the words around them and where each one goes.
 *
 * ONE NAME: the "SwapUp grade" (Superb / Good / Fair / Best Value, with its
 * letter A–D), and its "Grade report". The label already reads "Good (B)";
 * LETTER_NOTE explains the letter wherever the letter is printed. Never a CTIA
 * grade, and never GradeIQ's camera letter, which stays in the desk report's
 * staff-only section.
 *
 * NO MONEY, ever. The report body has none (lib/domain/gradingReport.ts) and
 * nothing here adds any: the grade never moves a price.
 *
 * Runtime imports are relative with ".ts" so `node --test` can load this file;
 * everything from lib/server is a type only.
 */
import { EVIDENCE_SOURCE_LABEL, LETTER_NOTE, type GradingStatus, type Reason, type TestLine } from "../../lib/domain/grading.ts";
import { PC_UPLOAD_MAX_BYTES, PC_UPLOAD_MIMES, type PcUploadMime } from "../../lib/domain/phonecheck.ts";
import { REPORT_SCALE, type ReportBody } from "../../lib/domain/gradingReport.ts";
import type { ReportEnvelope, ReportReason } from "../../lib/server/gradingReport.ts";
import type { PcSummary } from "../../lib/server/phonecheck.ts";

export { LETTER_NOTE };

/* ─────────────────────────── the grade line ─────────────────────────── */

export type Tone = "up" | "warn" | "bad" | "plain";

/** Green only for a final grade; amber while a person still has to check something; red when it can't take a grade as it is. */
export function gradeTone(status: GradingStatus, final: boolean): Tone {
  if (status === "graded") return final ? "up" : "warn";
  if (status === "needs_repair" || status === "cannot_grade") return "bad";
  if (status === "incomplete") return "warn";
  return "plain";
}

export const TONE_PILL: Readonly<Record<Tone, string>> = { up: "pill-up", warn: "pill-warn", bad: "pill-bad", plain: "" };
/** The desk's text colours for a tone (never the only signal: the words say it too). */
export const TONE_TEXT: Readonly<Record<Tone, string>> = { up: "text-up", warn: "text-warn", bad: "text-bad", plain: "" };

/** "SwapUp grade: Good (B)" — the one line on the case, as on the store app. The label is the server's, as-is. */
export function gradeLine(label: string): string {
  return `SwapUp grade: ${label}`;
}

/**
 * What the advisor checked by eye, as one line on the case (the answer card):
 * "Certified by Asha K.: screen OK on the test colours, body scuffs, liquid indicator clean."
 * null when nothing is certified. The words are the chips'; the names are the people's.
 */
export function certifiedLine(c: Partial<Record<"screen" | "body" | "liquid", { label: string; by: string; withColours: boolean }>> | null | undefined): string | null {
  if (!c) return null;
  const rows = (["screen", "body", "liquid"] as const).flatMap((row) => {
    const r = c[row];
    if (!r) return [];
    const what = row === "liquid" ? `liquid indicator ${r.label.toLowerCase()}` : `${row} ${r.label === "OK" ? "OK" : r.label.toLowerCase()}${row === "screen" && r.withColours ? " on the test colours" : ""}`;
    return [{ by: r.by, what }];
  });
  if (!rows.length) return null;
  const names = [...new Set(rows.map((r) => r.by))];
  const parts = names.map((n) => `${n}: ${rows.filter((r) => r.by === n).map((r) => r.what).join(", ")}`);
  return `Certified by ${parts.join("; ")}.`;
}

/* ─────────────────────────── links ─────────────────────────── */

const TOKEN_PATH = /^\/r\/([A-Za-z0-9_-]{16,64})(?:\?|$)/;

/** The token in "/r/<token>[?v=n]", or null. */
export function tokenOf(path: string | null | undefined): string | null {
  const m = TOKEN_PATH.exec(path ?? "");
  return m ? m[1] : null;
}

/** "/r/<token>?v=3" — a link that always opens exactly that version (the receipt's, the partner's). */
export function pinnedPath(path: string, version: number): string {
  return `${path.split("?")[0]}?v=${version}`;
}

/** The link as printed or put in a QR: the public origin + path. A path that is already absolute is kept. */
export function absoluteUrl(origin: string | null | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${(origin ?? "").replace(/\/+$/, "")}${path}`;
}

/** The first 12 hex digits of a version's sha256 — enough to tell two versions apart on paper. */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

/* ─────────────────────────── dates ─────────────────────────── */

/**
 * "17 Oct, 7:21 pm", fixed to India time like the rest of the counter
 * (components/counter/shared.ts fmtWhen — not imported: its @/ imports don't
 * load under node --test).
 */
export function when(iso: string | null | undefined, style: "datetime" | "date" = "datetime"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    style === "date" ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
}

/* ─────────────────────────── words ─────────────────────────── */

export const RESULT_WORD: Readonly<Record<TestLine["result"], string>> = {
  passed: "Passed",
  failed: "Failed",
  not_tested: "Not tested",
  not_on_phone: "Not on this phone",
};

const RESULT_TONE: Readonly<Record<TestLine["result"], Tone>> = { passed: "up", failed: "bad", not_tested: "warn", not_on_phone: "plain" };

const OUTCOME_WORD: Readonly<Record<string, string>> = {
  pass: "passed",
  fail: "failed",
  skip: "not tested",
  unsupported: "not on this phone",
  pending: "pending",
};

export const REASON_WORD: Readonly<Record<ReportReason, string>> = {
  swapup_check: "after the test was applied",
  phonecheck: "after a Phonecheck result",
  certified: "after the advisor's check",
  edited: "after an edit",
  traded_in: "frozen at hand-over",
  backfill: "first issue",
  wording: "today's wording",
};

const VARIANT_SOURCE_WORD: Readonly<Record<string, string>> = {
  measured: "measured on the phone",
  catalogue: "the only size on file",
  customer: "as the customer said",
  advisor: "set by staff",
};

const MODEL_MATCH_WORD: Readonly<Record<string, string>> = {
  exact: "Model code match",
  family: "Model family match",
  none: "Chosen at the counter",
};

const CAMERA_WORD: Readonly<Record<string, string>> = {
  none: "Not camera-graded — recorded by eye.",
  grading: "Camera still grading.",
  provisional: "Camera grade — not final.",
  final: "Camera grade (final).",
  failed: "Camera grading failed — recorded by eye.",
};

const LCD_WORD: Readonly<Record<ReportBody["camera"]["lcd"], string>> = {
  passed: "Screen sweep passed.",
  failed: "Screen sweep found a fault.",
  not_checked: "No camera screen sweep.",
  unsure: "Screen sweep unsure — checked by eye.",
};

const BATTERY_SOURCE_WORD: Readonly<Record<string, string>> = {
  screenshot: "battery screen (SwapUp Check)",
  phonecheck: "Phonecheck",
  phonecheck_upload: "Phonecheck upload",
};

const PARTS_WORD: Readonly<Record<string, string>> = { genuine: "Original", not_genuine: "Not original", unknown: "Unknown" };
const yesNo = (b: boolean | null | undefined, yes = "Yes", no = "No"): string => (b === null || b === undefined ? "—" : b ? yes : no);
const onOff = (s: "on" | "off" | null | undefined): string => (s === "on" ? "On" : s === "off" ? "Off" : "—");
const workingWord = (w: string | null | undefined): string => (w === "yes" ? "Yes" : w === "no" ? "No" : w === "pending" ? "Pending" : "—");

/**
 * "SwapUp Check: passed" · "Phonecheck (uploaded): failed — Microphone, Front Mic Quality" · "(manual check)" ·
 * "Store camera colour check: passed" · "Advisor Asha K., by eye on the test colours: passed".
 */
export function sourceWord(s: TestLine["sources"][number]): string {
  const names = s.names?.length ? ` — ${s.names.join(", ")}` : "";
  const outcome = OUTCOME_WORD[s.outcome] ?? s.outcome;
  if (s.source === "advisor") return `Advisor${s.by ? ` ${s.by}` : ""}, by eye${s.colours ? " on the test colours" : ""}: ${outcome}`;
  if (s.via === "store_camera") return `Store camera colour check: ${outcome}`;
  if (s.via === "self_test_and_store_camera") return `SwapUp Check and the store camera colour check: ${outcome}`;
  return `${EVIDENCE_SOURCE_LABEL[s.source] ?? s.source}: ${outcome}${s.manual ? " (manual check)" : ""}${names}`;
}

/** "18 tests: 15 passed, 1 failed, 2 not tested". */
export function testCounts(lines: readonly Pick<TestLine, "result">[]): { passed: number; failed: number; notTested: number; notOnPhone: number; total: number; line: string } {
  const n = (r: TestLine["result"]) => lines.filter((l) => l.result === r).length;
  const c = { passed: n("passed"), failed: n("failed"), notTested: n("not_tested"), notOnPhone: n("not_on_phone"), total: lines.length };
  const bits = [`${c.passed} passed`];
  if (c.failed) bits.push(`${c.failed} failed`);
  if (c.notTested) bits.push(`${c.notTested} not tested`);
  if (c.notOnPhone) bits.push(`${c.notOnPhone} not on this phone`);
  return { ...c, line: `${c.total} ${c.total === 1 ? "test" : "tests"}: ${bits.join(", ")}` };
}

/**
 * What comes after the label: what it grades once repaired, the best it can
 * be once tested, or that it is provisional. Both scales — the server's labels.
 */
export function headlineExtra(g: Pick<ReportBody["grade"], "status" | "final" | "afterRepairLabel" | "ceilingLabel">): string | null {
  if (g.status === "needs_repair") return g.afterRepairLabel ? `After repair: ${g.afterRepairLabel}` : "No grade until repaired.";
  if (g.status === "incomplete") return g.ceilingLabel ? `At best ${g.ceilingLabel} once key tests pass` : null;
  // A graded, not-final phone: its label already says "provisional" — not said twice.
  return null;
}

/**
 * A short tail for one-line places (the receipt): what a phone with no grade
 * would grade once repaired, or at best — both scales. "" when there is none.
 */
export function gradeTail(g: Pick<ReportBody["grade"], "status" | "afterRepairLabel" | "ceilingLabel">): string {
  if (g.status === "needs_repair" && g.afterRepairLabel) return ` · after repair ${g.afterRepairLabel}`;
  if (g.status === "incomplete" && g.ceilingLabel) return ` · at best ${g.ceilingLabel}`;
  return "";
}

/** The reasons as a card shows them: the one-line why, the rest, what to check by hand, what a buyer must hear. */
export function reasonLists(g: { reasons: Reason[]; provisional: Reason[]; disclosures: Reason[] }): { why: string | null; more: string[]; check: string[]; disclose: string[] } {
  return {
    why: g.reasons[0]?.text ?? null,
    more: g.reasons.slice(1).map((r) => r.text),
    check: g.provisional.map((r) => r.text),
    disclose: g.disclosures.map((r) => r.text),
  };
}

/* ─────────────────────────── the report, as a page reads it ─────────────────────────── */

export type Row = { label: string; value: string; note?: string | null };

/** A mark drawn over a photo: where (percent of the photo), how bad, and what. */
export type Mark = { top: number; left: number; width: number; height: number; tone: Tone; what: string };

export type ReportView = {
  ref: string;
  store: string;
  storeCode: string | null;
  headline: { status: GradingStatus; label: string; tone: Tone; final: boolean; extra: string | null };
  /** What the grade is (REPORT_SCALE, today's words even on an older version), then the A–D line — printed under the grade, always. */
  scale: string;
  letterNote: string;
  why: string | null;
  more: string[];
  check: string[];
  /** What the advisor checked by eye, by name — one line per row (the store camera couldn't decide). */
  checked: string[];
  disclose: string[];
  phone: Row[];
  /** The government register and Phonecheck's lock checks, together. */
  locks: Row[];
  tests: { id: string; name: string; key: boolean; word: string; tone: Tone; sources: string[] }[];
  testCounts: string;
  otherTests: { name: string; word: string; tone: Tone; source: string; manual: boolean }[];
  battery: { value: string; tone: Tone; note: string; readings: string[] };
  condition: Row[] | null;
  camera: {
    summary: string;
    lcd: string | null;
    findings: { part: string; what: string; severity: string; photo: string | null }[];
    /** Every exterior photo with its angle and, from a final grade, its marks boxed. Empty on versions issued before photos were kept. */
    photos: { n: number; label: string; src: string; marks: Mark[] }[];
    /** Under the photos: who took them and why they weren't graded (null when the camera graded them). */
    caption: string | null;
    /** Part by part, in words (a final grade only). */
    parts: { part: string; word: string; note: string | null }[];
  };
  /** The screen colour test (null on versions issued before it was kept). */
  screen: {
    colours: { pattern: string; name: string; photo: string | null; marks: Mark[] }[];
    /** "4 of 6 colours photographed". */
    count: string;
    /** In one line: what the store camera found, or why it couldn't, and who checked it by hand. */
    lines: string[];
  } | null;
  faults: { label: string; sources: string }[];
  repairs: { parts: string[]; inspection: string[] };
  references: Row[];
  footer: { version: number; issuedAt: string; reason: string; ruleset: string; sha256: string; final: boolean; buyerLine: string; hashNote: string; checkedBy: string | null };
};

const SEVERITY_TONE: Readonly<Record<string, Tone>> = { severe: "bad", moderate: "warn", minor: "plain" };

/** A [ymin, xmin, ymax, xmax] box in 0..1 → a percent rectangle, or null when it doesn't describe one. */
export function markOf(box: readonly number[] | null | undefined, severity: string | null | undefined, what: string): Mark | null {
  if (!box || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [y0, x0, y1, x1] = box.map((n) => Math.min(1, Math.max(0, n)));
  if (y1 <= y0 || x1 <= x0) return null;
  const pct = (n: number) => Math.round(n * 1000) / 10;
  return { top: pct(y0), left: pct(x0), height: pct(y1 - y0), width: pct(x1 - x0), tone: SEVERITY_TONE[severity ?? ""] ?? "plain", what };
}

export const COLOUR_NAME: Readonly<Record<string, string>> = { white: "White", black: "Black", red: "Red", green: "Green", blue: "Blue", stripes: "Stripes", grey: "Grey", gray: "Grey" };
const colourName = (p: string) => COLOUR_NAME[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : p);

const IDENTITY_WORD: Readonly<Record<string, string>> = {
  match: "Matches (store camera)",
  mismatch: "Store camera doubts it",
  unverified: "Not checked",
};

export const BUYER_LINE = "As tested at the store. The buyer's inspection decides the final price.";

/** The proxied photo for finding n of this version (never GradeIQ's own URL — it carries that session's write key). */
export function photoPath(token: string, n: number, version: number): string {
  return `/api/r/${encodeURIComponent(token)}/photo/${n}?v=${version}`;
}

/**
 * One issued version → everything the report page prints, in order (spec §4.6):
 * grade, phone, tests, battery, screen and body, faults and parts, disclosures,
 * references, footer. Deterministic; reads only the envelope.
 */
export function reportView(env: Pick<ReportEnvelope, "version" | "issuedAt" | "reason" | "final" | "sha256" | "body">, token: string): ReportView {
  const b = env.body;
  const g = b.grade;
  const r = reasonLists(g);

  const phone: Row[] = [{ label: "Phone", value: b.phone.label ?? "Not recorded" }];
  phone.push({ label: "Storage", value: b.phone.variant ?? "Not recorded", note: b.phone.variant && b.phone.variantSource ? (VARIANT_SOURCE_WORD[b.phone.variantSource] ?? null) : null });
  if (b.phone.modelMatch) phone.push({ label: "Model", value: MODEL_MATCH_WORD[b.phone.modelMatch] ?? b.phone.modelMatch });
  phone.push({
    label: "IMEI",
    value: b.phone.imei ?? "Not recorded",
    note: b.phone.imeiCheckDigit === "valid" ? "check digit OK" : b.phone.imeiCheckDigit === "invalid" ? "check digit failed" : null,
  });
  if (b.phone.imei2) phone.push({ label: "IMEI 2", value: b.phone.imei2 });
  if (b.phone.colour) phone.push({ label: "Colour", value: b.phone.colour });
  if (b.phone.os) phone.push({ label: "Software", value: b.phone.os });
  if (b.phone.identity) {
    const id = b.phone.identity;
    phone.push({ label: "Identity", value: id.verdict === "mismatch" && id.acceptedBy ? `Accepted by ${id.acceptedBy} — camera doubted it` : (IDENTITY_WORD[id.verdict] ?? id.verdict) });
  }
  const pcParts = b.parts?.phonecheck ?? b.phonecheck?.parts ?? null;
  const camParts = b.parts?.camera ?? null;
  if (pcParts || camParts) {
    const words = [
      pcParts ? `${PARTS_WORD[pcParts] ?? pcParts} (Phonecheck)` : null,
      camParts === "suspect" ? "Camera suspects a non-original part" : camParts === "no_sign" ? "None non-original (camera)" : camParts === "unsure" ? "Camera unsure" : null,
    ].filter(Boolean);
    phone.push({ label: "Parts", value: words.join(" · "), note: b.parts?.evidence.length ? b.parts.evidence.join("; ") : null });
  }

  // The locks, together: the government register (after lock) and what Phonecheck read.
  const locks: Row[] = [];
  if (b.phone.kym) locks.push({ label: "Government IMEI register", value: b.phone.kym.label, note: b.phone.kym.at ? `checked ${when(b.phone.kym.at)}` : null });
  const lk = b.locks ?? (b.phonecheck ? { activation: b.phonecheck.deviceLock, rooted: null, mdm: null } : null);
  if (lk) {
    locks.push({ label: "Activation lock", value: onOff(lk.activation), note: "Phonecheck" });
    if (lk.rooted) locks.push({ label: "Rooted", value: lk.rooted === "on" ? "Yes" : "No", note: "Phonecheck" });
    if (lk.mdm) locks.push({ label: "Device management (MDM)", value: onOff(lk.mdm), note: "Phonecheck" });
  }

  // Battery health is its own section, once — not a test line too.
  const tests = b.tests
    .filter((t) => t.id !== "battery_health")
    .map((t) => ({ id: t.id, name: t.name, key: t.key, word: RESULT_WORD[t.result], tone: RESULT_TONE[t.result], sources: t.sources.map(sourceWord) }));
  const otherTests = b.otherTests.map((o) => ({
    name: o.name,
    word: o.result === "passed" ? "Passed" : o.result === "failed" ? "Failed" : "Pending",
    tone: (o.result === "passed" ? "up" : o.result === "failed" ? "bad" : "warn") as Tone,
    source: EVIDENCE_SOURCE_LABEL[o.source] ?? o.source,
    manual: o.manual,
  }));

  const pct = b.battery.healthPct;
  // One reading: its source goes in the note — the figure is said once. Several: each, and the lowest counts.
  const one = b.battery.readings.length === 1 ? b.battery.readings[0] : null;
  const battery = {
    value: pct === null ? "Not read" : `${pct} %`,
    tone: (pct === null ? "warn" : pct >= b.battery.passLine ? "up" : "bad") as Tone,
    note: one
      ? `${BATTERY_SOURCE_WORD[one.source] ?? one.source}${one.at ? `, ${when(one.at)}` : ""} · pass line ${b.battery.passLine} %`
      : `Pass line ${b.battery.passLine} % · lowest reading counts`,
    readings: [
      ...(one ? [] : b.battery.readings.map((x) => `${x.pct} % — ${BATTERY_SOURCE_WORD[x.source] ?? x.source}${x.at ? `, ${when(x.at)}` : ""}`)),
      ...(typeof b.battery.cycles === "number" ? [`${b.battery.cycles} charge cycles — Phonecheck`] : []),
    ],
  };

  const condition: Row[] | null = b.condition
    ? [
        { label: "Screen", value: b.condition.screen },
        { label: "Body", value: b.condition.body },
        { label: "Other problems", value: b.condition.issues.length ? b.condition.issues.join(", ") : "None" },
        { label: "Switches on", value: yesNo(b.condition.powersOn) },
        { label: "Calls", value: yesNo(b.condition.calls, "Work", "Don't work") },
      ]
    : null;

  const cert = b.certification ?? {};
  const certifiedBody = cert.body ?? null;
  const photos = (b.camera.photos ?? []).map((p) => ({
    n: p.n,
    label: p.label,
    src: photoPath(token, p.n, env.version),
    marks: b.camera.findings.filter((f) => f.photo === p.n).map((f) => markOf(f.box, f.severity, f.what)).filter((m): m is Mark => !!m),
  }));
  // No store camera at all — no photo, no colour frame, no sweep: ONE line says so, not four.
  const frames = b.screen ? b.screen.colours.filter((c) => c.photo !== null).length : 0;
  const noCamera = !photos.length && !frames && b.camera.lcd === "not_checked" && !b.camera.final && !b.screen?.marks.length;
  const camera = {
    summary: noCamera ? (b.camera.why ?? CAMERA_WORD.none) : b.camera.checked ? (CAMERA_WORD[b.camera.status ?? "none"] ?? CAMERA_WORD.none) : CAMERA_WORD.none,
    lcd: noCamera ? null : LCD_WORD[b.camera.lcd],
    findings: b.camera.findings.map((f) => ({ part: f.part, what: f.what, severity: f.severity, photo: f.photo === null ? null : photoPath(token, f.photo, env.version) })),
    photos,
    caption: b.camera.final || noCamera
      ? null
      : photos.length
        ? certifiedBody
          ? `Not camera-graded — ${certifiedBody.by} recorded it by eye.`
          : (b.camera.why ?? "Photos not graded.")
        : (b.camera.why ?? null),
    parts: (b.camera.parts ?? []).map((p) => ({ part: p.part[0].toUpperCase() + p.part.slice(1), word: p.word, note: p.note })),
  };

  // The screen colour test: each colour, its frame, the reader's marks; then what decided it.
  let screen: ReportView["screen"] = null;
  if (b.screen && !noCamera) {
    const sc = b.screen;
    const colours = sc.colours.map((c) => ({
      pattern: c.pattern,
      name: colourName(c.pattern),
      photo: c.photo === null ? null : photoPath(token, c.photo, env.version),
      marks: sc.marks.filter((m) => m.pattern === c.pattern).map((m) => markOf(m.box, m.severity, m.what)).filter((m): m is Mark => !!m),
    }));
    const shot = sc.colours.filter((c) => c.photo !== null).length;
    const lines: string[] = [];
    if (b.camera.lcd !== "not_checked") lines.push(LCD_WORD[b.camera.lcd]);
    else if (sc.why) lines.push(sc.why);
    for (const m of sc.marks) lines.push(`${m.what}${m.pattern ? ` (on ${colourName(m.pattern).toLowerCase()})` : ""}${m.severity ? ` — ${m.severity}` : ""}.`);
    // The advisor's look is in "Certified by the advisor" — said there once.
    if (!cert.screen && b.camera.lcd === "not_checked") lines.push("Screen colours: not checked.");
    screen = { colours, count: sc.colours.length ? `${shot} of ${sc.colours.length} colours photographed` : "No colours photographed", lines };
  }

  const references: Row[] = [];
  // The store camera's record, only when its photos or its grade are on this report.
  if (b.camera.reference && (photos.length || b.camera.final)) references.push({ label: "Store camera report", value: b.camera.reference });
  const pc = b.phonecheck;
  if (pc) {
    references.push({
      label: "Phonecheck",
      value: pc.aiRead ? "Upload, read by AI" : pc.uploaded ? "Uploaded by staff" : "Fetched from Phonecheck",
      note: pc.aiRead ? "Check the figures against the report." : null,
    });
    references.push({ label: "Phonecheck report no.", value: pc.reportNo ?? "—" });
    references.push({ label: "Tested on Phonecheck", value: pc.testedAt ? when(pc.testedAt) : "Time not recorded" });
    if (pc.station) references.push({ label: "Phonecheck station", value: pc.station });
    references.push({ label: "Phonecheck's overall result", value: workingWord(pc.working) });
    if (pc.testerGrade) references.push({ label: "Phonecheck tester's grade", value: pc.testerGrade, note: "not used for this grade" });
    references.push({ label: "Erased on Phonecheck", value: yesNo(pc.erased) });
  }
  if (b.checkedAt.swapupCheck) {
    const app = b.sessions.app === "browser" ? "web browser" : b.sessions.app === "native" ? `SwapUp Check app${b.sessions.appVersion ? ` ${b.sessions.appVersion}` : ""}` : null;
    references.push({
      label: "SwapUp Check",
      value: when(b.checkedAt.swapupCheck),
      note: [app, b.sessions.earlierSessions ? `${b.sessions.earlierSessions} earlier ${b.sessions.earlierSessions === 1 ? "test" : "tests"}` : null].filter(Boolean).join(" · ") || null,
    });
  }
  if (b.checkedAt.camera) references.push({ label: "Store camera", value: when(b.checkedAt.camera) });

  return {
    ref: b.case.ref,
    store: b.case.store,
    storeCode: b.case.storeCode,
    headline: { status: g.status, label: g.label, tone: gradeTone(g.status, g.final), final: g.final, extra: headlineExtra(g) },
    // Today's wording, not the one hashed into an older version's body: the line names the scale, it isn't evidence.
    scale: REPORT_SCALE,
    letterNote: g.letterScale || LETTER_NOTE,
    why: r.why,
    more: r.more,
    check: r.check,
    checked: (["screen", "body", "liquid"] as const).map((row) => cert[row]?.line).filter((x): x is string => !!x),
    disclose: r.disclose,
    phone,
    locks,
    tests,
    testCounts: testCounts(b.tests.filter((t) => t.id !== "battery_health")).line,
    otherTests,
    battery,
    condition,
    camera,
    screen,
    // "found by Store camera, Asha K., by eye" — a fault the advisor's certification put on names them.
    faults: b.faults.map((f) => ({ label: f.label, sources: f.sources.map((x) => (x === "Advisor" && f.certifiedBy ? `${f.certifiedBy}, by eye` : x)).join(", ") })),
    repairs: { parts: b.repairs.parts, inspection: b.repairs.inspection },
    references,
    footer: {
      version: env.version,
      issuedAt: when(env.issuedAt),
      reason: REASON_WORD[env.reason] ?? env.reason,
      ruleset: b.ruleset,
      sha256: env.sha256,
      final: env.final,
      buyerLine: BUYER_LINE,
      hashNote: `A fingerprint, not a signature. Recompute it from /api/r/${encodeURIComponent(token)}?v=${env.version}.`,
      // The certification box already names whoever checked by eye.
      checkedBy: Object.keys(cert).length ? null : (b.camera.checkedBy ?? null),
    },
  };
}

/* ─────────────────────────── the Phonecheck panel ─────────────────────────── */

/** The JSON a Phonecheck station exports; the server refuses more (app/api/cases/[id]/phonecheck). */
export const PC_JSON_MAX_BYTES = 256 * 1024;

const EXT_MIME: Readonly<Record<string, PcUploadMime>> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * A file staff picked → what to send, or why not (before any upload, and
 * before the paid AI read). The server checks again from the file's own bytes.
 *   "json"    the Phonecheck JSON export → {mode:"upload", record}
 *   "report"  the report as a PDF or photo → multipart, read by AI
 */
export function checkUpload(
  file: { name: string; type: string; size: number },
  as: "json" | "report"
): { ok: true; kind: "json" } | { ok: true; kind: "report"; mime: PcUploadMime } | { ok: false; reason: string } {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "").toLowerCase();
  const type = (file.type || "").split(";")[0].trim().toLowerCase();
  if (!file.size) return { ok: false, reason: "That file is empty." };
  if (as === "json") {
    if (type !== "application/json" && ext !== "json") return { ok: false, reason: "Choose a .json file, or use “Report PDF or photo”." };
    if (file.size > PC_JSON_MAX_BYTES) return { ok: false, reason: "Over 256 KB — export just this phone." };
    return { ok: true, kind: "json" };
  }
  if (type === "image/heic" || type === "image/heif" || ext === "heic" || ext === "heif")
    return { ok: false, reason: "HEIC can't be read — upload a screenshot or the PDF." };
  const mime = (PC_UPLOAD_MIMES as readonly string[]).includes(type) ? (type as PcUploadMime) : type === "image/jpg" ? "image/jpeg" : !type ? (EXT_MIME[ext] ?? null) : null;
  if (!mime) return { ok: false, reason: "Upload a PDF, JPEG, PNG or WebP." };
  if (file.size > PC_UPLOAD_MAX_BYTES) return { ok: false, reason: `Over ${PC_UPLOAD_MAX_BYTES / 1048576} MB — upload a smaller file.` };
  return { ok: true, kind: "report", mime };
}

/** A Phonecheck JSON file's text → the record to send, or why it can't be. */
export function readJsonUpload(text: string): { ok: true; record: unknown } | { ok: false; reason: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (v === null || typeof v !== "object") return { ok: false, reason: "That JSON isn't a Phonecheck record." };
  return { ok: true, record: v };
}

/** The 409 the case route answers for a report whose IMEI isn't the case's — it carries the stored record, to attach with a reason. */
export function mismatchOf(status: number, data: unknown): { error: string; record: PcSummary } | null {
  if (status !== 409 || !data || typeof data !== "object") return null;
  const d = data as { outcome?: unknown; error?: unknown; record?: unknown };
  if (d.outcome !== "mismatch" || !d.record || typeof d.record !== "object" || typeof (d.record as { id?: unknown }).id !== "string") return null;
  return { error: typeof d.error === "string" ? d.error : "This Phonecheck report is for another IMEI.", record: d.record as PcSummary };
}

/** A store manager's reason for attaching a report with another IMEI — the server asks for 8 characters or more. */
export function overrideReasonOk(reason: string): boolean {
  return reason.trim().length >= 8;
}

/**
 * What the AI read off an uploaded report, field by field, for staff to check
 * against the paper. A field the AI couldn't read is missing from what it
 * returned (never invented) — it shows as "not read".
 */
export const EXTRACTED_FIELDS: readonly [key: string, label: string][] = [
  ["IMEI", "IMEI"],
  ["IMEI2", "IMEI 2"],
  ["Make", "Make"],
  ["Model", "Model"],
  ["ModelNo", "Model no."],
  ["Memory", "Storage"],
  ["Working", "Working"],
  ["Failed", "Failed"],
  ["Pending", "Pending"],
  ["Passed", "Passed"],
  ["BatteryHealthPercentage", "Battery health %"],
  ["BatteryCycle", "Battery cycles"],
  ["DeviceLock", "Activation lock"],
  ["Erased", "Erased"],
  ["Parts", "Parts"],
  ["Grade", "Tester's grade (not used)"],
  ["StationID", "Station"],
  ["A4Reports", "Report no."],
  ["UpdatedTimeStamp", "Tested at"],
  ["DeviceUpdatedDate", "Tested at (no zone)"],
];

export function extractedRows(raw: Record<string, unknown> | null | undefined): { label: string; value: string; read: boolean }[] {
  const r = raw ?? {};
  const has = (k: string) => r[k] !== undefined && r[k] !== null && r[k] !== "";
  // One "tested at" row: the time with its zone, else the zone-less one Phonecheck printed.
  const zoneless = !has("UpdatedTimeStamp") && has("DeviceUpdatedDate");
  return EXTRACTED_FIELDS.filter(([k]) => (k === "DeviceUpdatedDate" ? zoneless : k === "UpdatedTimeStamp" ? !zoneless : true))
    .map(([k, label]) => {
      const v = r[k];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return { label, value: "not read", read: false };
      if (k === "Parts" && typeof v === "string") {
        try {
          const remarks = (JSON.parse(v) as { Remarks?: unknown }).Remarks;
          if (typeof remarks === "string") return { label, value: remarks, read: true };
        } catch {
          /* shown verbatim below */
        }
      }
      return { label, value: Array.isArray(v) ? v.map(String).join(", ") : String(v), read: true };
    });
}

/** One stored Phonecheck record as a line: "Samsung Galaxy S23 Ultra · tested 17 Oct 2026, 7:21 pm · 1 failed · battery 91 % · pulled". */
export function pcRecordLine(r: Pick<PcSummary, "phone" | "testedAt" | "failed" | "pending" | "batteryHealthPct" | "source" | "aiRead" | "reportNo">): string {
  const via = r.aiRead ? "read by AI from an upload" : r.source === "pull" ? "pulled from Phonecheck" : r.source === "webhook" ? "sent by Phonecheck" : "uploaded";
  const bits = [r.phone ?? "Phone not named", r.testedAt ? `tested ${when(r.testedAt)}` : "test time not recorded"];
  bits.push(r.failed.length ? `${r.failed.length} failed` : "none failed");
  if (r.pending.length) bits.push(`${r.pending.length} pending`);
  bits.push(r.batteryHealthPct === null ? "battery not read" : `battery ${r.batteryHealthPct} %`);
  if (r.reportNo) bits.push(`report ${r.reportNo}`);
  bits.push(via);
  return bits.join(" · ");
}
