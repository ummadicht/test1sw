/**
 * THE PHONE-LED FLOW — SwapUp Check ≥ 0.6.0 runs GradeIQ v2's order on the
 * customer's own phone: Identify › Scan › Test › Result (docs/PHONE-LED-FLOW.md).
 * The phone moves itself from step to step; the store tablet scans it, watches,
 * prices and applies.
 *
 * Older apps keep today's order exactly (tests first, photo screen last, the
 * store's photos before the phone joins — docs/TWO-PASS-CAMERA.md). Everything
 * the server does differently is behind scanFirstApp(), decided from the
 * appVersion the phone reports when it joins.
 *
 * Pure functions only — no database, no clock.
 */
import { BATTERY_HEALTH_ID, type DeviceReport, type ModelMatch, type PlanItem, type TestResult } from "./diagnostics.ts";

/* ─────────────────────────── which app is this ─────────────────────────── */

/** "0.6.0" or "web-0.6.0" (the browser build) → its parts; anything else → null. */
export function readAppVersion(raw: unknown): { web: boolean; version: [number, number, number] } | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const web = s.startsWith("web-");
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(web ? s.slice(4) : s);
  if (!m) return null;
  return { web, version: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}

export const SCAN_FIRST_FROM = [0, 6, 0] as const;

/**
 * SwapUp Check ≥ 0.6.0 — native, or the browser build "web-0.6.0" and later.
 * It identifies itself, then shows the scan code (GradeIQ's camera link) BEFORE
 * its tests, and reads its battery health from a screenshot. No device report,
 * or an unreadable version, is an older app: today's behaviour.
 */
export function scanFirstApp(device: Pick<DeviceReport, "appVersion"> | null | undefined): boolean {
  const r = readAppVersion(device?.appVersion);
  return !!r && versionAtLeast(r.version, SCAN_FIRST_FROM);
}

/* ─────────────────────────── where the phone is ─────────────────────────── */

export const PHONE_PHASES = ["identify", "scan", "battery", "test", "done"] as const;
export type PhonePhase = (typeof PHONE_PHASES)[number];

export function readPhase(raw: unknown): PhonePhase | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (PHONE_PHASES as readonly string[]).includes(s) ? (s as PhonePhase) : null;
}

/* ─────────────────────────── the plan this app gets ─────────────────────────── */

const BATTERY_HEALTH_ITEM: PlanItem = { id: BATTERY_HEALTH_ID, name: "Battery health", critical: false };

/**
 * The plan as this app should see it. battery_health is a step only ≥ 0.6.0
 * has: an older app would record it "unsupported — not available in this app"
 * and the store would see one more untested line for a step that was never
 * offered. So it is taken out for older apps, and put back (after `battery`)
 * for a new app joining a session made before the step existed.
 */
export function planForApp(plan: readonly PlanItem[], scanFirst: boolean): PlanItem[] {
  const has = plan.some((p) => p.id === BATTERY_HEALTH_ID);
  if (!scanFirst) return plan.filter((p) => p.id !== BATTERY_HEALTH_ID);
  if (has) return [...plan];
  const at = plan.findIndex((p) => p.id === "battery");
  return at < 0 ? [...plan, BATTERY_HEALTH_ITEM] : [...plan.slice(0, at + 1), BATTERY_HEALTH_ITEM, ...plan.slice(at + 1)];
}

/**
 * battery_health is the server's to record (POST /api/device/battery, from what
 * GradeIQ read). Through /api/device/results the phone may only say it was
 * skipped — and only while there is no reading, so tapping Skip after a 72 %
 * reading can't wipe the battery fault. Every other test id is unaffected.
 */
export function phoneMayPost(testId: string, outcome: string, existing: { [id: string]: { outcome: string } | undefined }): boolean {
  if (testId !== BATTERY_HEALTH_ID) return true;
  if (outcome !== "skip" && outcome !== "unsupported") return false;
  const cur = existing[testId]?.outcome;
  return cur !== "pass" && cur !== "fail";
}

/**
 * A new screenshot's reading against what is stored. A screenshot that couldn't
 * be read never wipes an earlier reading (null = keep what is there). A new
 * reading replaces the old one — the first may have been the wrong screen — but
 * the earlier figures stay in `detail.earlier`, so the store can see a seller
 * who tried several screenshots.
 */
export function nextBatteryHealth(existing: TestResult | undefined, reading: TestResult): TestResult | null {
  const had = existing && (existing.outcome === "pass" || existing.outcome === "fail");
  if (reading.outcome === "skip") return had ? null : reading;
  if (!had) return reading;
  const prev = existing!.detail ?? {};
  const earlier = [...(Array.isArray(prev.earlier) ? (prev.earlier as unknown[]) : []), prev.healthPct].filter((x): x is number => typeof x === "number").slice(-5);
  return { ...reading, detail: { ...(reading.detail ?? {}), earlier } };
}

/* ─────────────────────────── identity ─────────────────────────── */

/** What the join response tells the phone about itself — the model match, nothing priced. */
export type JoinIdentity = { label: string | null; match: ModelMatch["match"]; reason: string; variant: string | null; modelId: string | null };

export function identityForJoin(m: ModelMatch): JoinIdentity {
  return { label: m.label, match: m.match, reason: m.why, variant: m.variant, modelId: m.modelId };
}

export type ImeiAgreement = "match" | "differs" | "unknown";

/**
 * The IMEI(s) the customer's phone gave (*#06#) against the ones on the case.
 * Either side empty → unknown (nothing to compare). "differs" when the two
 * share no number at all — a two-SIM phone has two, typed in either order, and
 * a case may hold only one of them. (SwapUp Store reads it the same way.)
 */
export function imeiAgreement(
  said: { imei?: string | null; imei2?: string | null } | null | undefined,
  onCase: { imei: string | null; imei2: string | null }
): ImeiAgreement {
  const phone = [said?.imei, said?.imei2].filter((x): x is string => !!x);
  const recorded = [onCase.imei, onCase.imei2].filter((x): x is string => !!x);
  if (!phone.length || !recorded.length) return "unknown";
  return phone.some((x) => recorded.includes(x)) ? "match" : "differs";
}

/* ─────────────────────────── what the store tablet is told ─────────────────────────── */

export type ScanFirstState = {
  phase: PhonePhase | null;
  /** The camera page is open to staff (the phone is echoing, or an override). */
  unlocked: boolean;
  /** Why it is not, when it is not (scanFirstLock). */
  locked: string | null;
  /**
   * A camera page has loaded for this session, or is driving a pattern. The
   * photos may not be reported accepted until well into the single pass, so
   * without this the line would say "scan it" while the camera is already working.
   */
  cameraAtWork: boolean;
  photosDone: boolean;
  screenDone: boolean;
  /** "Camera grade B (final)." / "Camera grade B is provisional. …" / a failure reason — null when there is none. */
  gradeLine: string | null;
  /** The grade will not change by waiting (final, failed, or provisional with nothing still refining it). */
  gradeSettled: boolean;
};

/**
 * The one line for a scan-first session's camera card, by where the phone says
 * it is. The camera grade is worked out while the phone tests itself, so the
 * line says that instead of asking the advisor to wait.
 */
export function scanFirstMessage(s: ScanFirstState): string {
  const phase = s.phase ?? "identify";
  const camera = s.photosDone || s.screenDone;
  if (phase === "identify" && !camera) return "The customer's phone is identifying itself. It shows its scan code next.";
  if (phase === "scan" || (phase === "identify" && camera)) {
    if (!camera) {
      if (!s.unlocked) return s.locked ?? "Waiting for the customer's phone to show its scan code…";
      return s.cameraAtWork
        ? "The store camera is photographing the customer's phone and checking its screen — keep the phone facing it."
        : "The customer's phone is showing its scan code — scan it with your camera, or Take photos.";
    }
    if (!s.screenDone) return "Photos accepted — the camera page checks the screen next. Keep the customer's phone facing it.";
    return s.gradeLine && s.gradeSettled ? s.gradeLine : "Photos and screen checked — the camera grade is being worked out.";
  }
  const where = phase === "done" ? "The customer's phone has finished its tests." : "The customer's phone is testing itself.";
  if (camera) {
    if (s.gradeLine && s.gradeSettled) return `${s.gradeLine} ${where}`;
    return phase === "done" ? `${where} The camera grade is being worked out.` : "The customer's phone is testing itself — the camera grade is being worked out.";
  }
  if (s.unlocked) return `${where} The camera check hasn't run — Take photos on this device.`;
  return `${where} The camera check didn't run, so check the screen and glass by eye — or Take photos with your name and a reason.`;
}

/** Why the camera page is still locked for a scan-first session (the phone isn't echoing its scan screen). */
export function scanFirstLock(phase: PhonePhase | null, cameraSkipped: boolean, sessionComplete: boolean): string {
  if (cameraSkipped || sessionComplete || (phase && phase !== "identify" && phase !== "scan"))
    return "The customer's phone went on without the camera check. Photos now need an override with your name and a reason (the LCD is then not camera-checked).";
  if (phase === "scan") return "Waiting for the customer's phone to show its scan code…";
  return "The customer's phone shows its scan code once it has identified itself — the camera unlocks by itself then.";
}
