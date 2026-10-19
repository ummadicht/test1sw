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
import type { VariantSource } from "./offer.ts";

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

export const COLOURS_FROM = [0, 8, 0] as const;

/**
 * SwapUp Check ≥ 0.8.0 (native or browser) shows the test colours on its result
 * screen for the advisor to certify the screen, and asks the customer nothing
 * about condition. An older app can't: its screen is certified without them.
 */
export function coloursApp(device: Pick<DeviceReport, "appVersion"> | null | undefined): boolean {
  const r = readAppVersion(device?.appVersion);
  return !!r && versionAtLeast(r.version, COLOURS_FROM);
}

/* ─────────────────────────── where the phone is ─────────────────────────── */

/**
 * "colours" (SwapUp Check ≥ 0.8.0): the tests are done and the phone is showing
 * the test colours full-screen while the advisor certifies its screen in SwapUp
 * Store (GET /api/device/status says `colours: true`). It goes back to "done"
 * when they stop.
 */
export const PHONE_PHASES = ["identify", "scan", "battery", "test", "done", "colours"] as const;
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
 *
 * `batteryKnown`: the case already has a battery-health % from another source (an
 * attached Phonecheck report). The screenshot step is then left out of the plan too,
 * so the customer isn't asked for it (owner, 2026-10-17: "the battery screenshot
 * only when no other battery source exists"); the grade reads that report's figure.
 */
export function planForApp(plan: readonly PlanItem[], scanFirst: boolean, batteryKnown = false): PlanItem[] {
  const has = plan.some((p) => p.id === BATTERY_HEALTH_ID);
  if (!scanFirst || batteryKnown) return plan.filter((p) => p.id !== BATTERY_HEALTH_ID);
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
 * be read never wipes an earlier reading (null = keep what is there). Of two
 * readings of this check the LOWER one is kept — a customer can't retry a sub-80 %
 * reading away with another screenshot — and every other figure stays in
 * `detail.earlier`, so the store can see a seller who tried several screenshots.
 */
export function nextBatteryHealth(existing: TestResult | undefined, reading: TestResult): TestResult | null {
  const had = existing && (existing.outcome === "pass" || existing.outcome === "fail");
  if (reading.outcome === "skip") return had ? null : reading;
  if (!had) return reading;
  const prev = existing!.detail ?? {};
  const pctOf = (r: TestResult) => (typeof r.detail?.healthPct === "number" ? (r.detail.healthPct as number) : null);
  const was = pctOf(existing!);
  const now = pctOf(reading);
  // The lower reading stands; the other one joins the earlier figures.
  const keepOld = was !== null && (now === null || was < now);
  const kept = keepOld ? existing! : reading;
  const other = keepOld ? now : was;
  const earlier = [...(Array.isArray(prev.earlier) ? (prev.earlier as unknown[]) : []), other].filter((x): x is number => typeof x === "number").slice(-5);
  const { earlier: _drop, ...keptDetail } = (kept.detail ?? {}) as Record<string, unknown>;
  return { ...kept, detail: { ...keptDetail, earlier }, at: reading.at };
}

/* ─────────────────────────── identity ─────────────────────────── */

/**
 * What the join response tells the phone about itself — the model match, nothing priced.
 * `variants` is the matched model's storage sizes, so the confirm card can ask "How much
 * storage?" when the phone couldn't measure it. Empty when no model matched (an older
 * server sends none at all — the app reads that as empty too) — and empty whenever the
 * phone MEASURED its storage, even a size that isn't on the model's list (a 1TB Ultra on
 * file as 256/512GB): the customer is never asked what the phone already answered, and
 * never offered only sizes the phone has ruled out.
 *
 * `measured` = storageVariant(totalDiskBytes), the phone's own reading. Default null.
 */
export type JoinIdentity = { label: string | null; match: ModelMatch["match"]; reason: string; variant: string | null; modelId: string | null; variants: string[] };

export function identityForJoin(m: ModelMatch, variants: string[] = [], measured: string | null = null): JoinIdentity {
  return { label: m.label, match: m.match, reason: m.why, variant: m.variant, modelId: m.modelId, variants: m.modelId && !measured ? [...variants] : [] };
}

/* ─────────────────────────── storage, at Apply ─────────────────────────── */

export type StorageFromTest = {
  variant: string | null;
  source: "measured" | "catalogue" | "customer" | null;
  flag: string | null;
  /** Present (true) only when the case's current size must be removed: a size the customer TYPED that the phone's reading contradicts. */
  clear?: true;
};

/**
 * The model whose storage Apply is settling: the phone's own match, else the
 * customer's pick when the case has no model yet or already has that one, else the
 * case's own model when the join told the phone it (`caseModelJoined`: a model the
 * IMEI named, the phone's code naming nothing, and no pick — the Check app skips
 * Identify on that "exact", so a pick never comes). null = no model to put a size on
 * (the pick would replace a model the case has).
 */
export function storageModelId(i: {
  match: { modelId: string | null };
  picked: { modelId: string } | null;
  caseModelId: string | null;
  caseModelJoined?: boolean;
}): string | null {
  if (i.match.modelId) return i.match.modelId;
  if (i.picked && (!i.caseModelId || i.caseModelId === i.picked.modelId)) return i.picked.modelId;
  if (i.caseModelJoined && !i.picked && i.caseModelId) return i.caseModelId;
  return null;
}

/**
 * The storage Apply writes to the case, and where it came from. First match wins:
 *
 *   1. measured   the phone read its own disk, and that size is on the model's list
 *                 — always used. A customer who picked the same model in another
 *                 size is told the measurement stands.
 *   1b. —         the phone read a size the model's list doesn't have (a 1TB Ultra
 *                 on file as 256/512GB): nothing is patched, the advisor is told,
 *                 and no claim, single size or pick is used against the reading.
 *   2. —          the case already has a size for this model: nothing is patched;
 *                 a claim never overwrites what the advisor recorded.
 *   3. catalogue  the model is sold in one size only.
 *   4. customer   the customer picked a size on their own phone (that model, a
 *                 size on its list). A CLAIM: enough to show prices, and the
 *                 advisor confirms it in Settings › About phone before the trade-in.
 *   5. —          nothing: the answer screen asks with one row of chips.
 *
 * `variants` is the sizes of the model storageModelId() names. `measured` is the
 * phone's own reading, storageVariant(totalDiskBytes) — it is a fact about the
 * phone's disk whichever way the model was named. Without it, the match's own
 * size is the reading (the matcher drops a size that isn't on the list).
 */
export function storageFromTest(i: {
  match: { modelId: string | null; variant: string | null };
  picked: { modelId: string; variant: string | null } | null;
  variants: string[];
  caseModelId: string | null;
  caseVariant: string | null;
  measured?: string | null;
  /** Where the case's current size came from — a customer's claim gives way to a reading. */
  caseSource?: VariantSource | null;
  /** The join told the phone the case's own model (storageModelId). */
  caseModelJoined?: boolean;
}): StorageFromTest {
  const none: StorageFromTest = { variant: null, source: null, flag: null };
  const model = storageModelId(i);
  if (!model) return none;
  const reading = i.measured ?? (i.match.modelId === model ? i.match.variant : null);
  // What the customer said about THIS model's storage on their phone, if anything.
  const said = i.picked && i.picked.modelId === model && i.picked.variant ? i.picked.variant : null;
  if (reading && i.variants.includes(reading)) {
    return {
      variant: reading,
      source: "measured",
      flag: said && said !== reading ? `Storage: customer said ${said}, phone measures ${reading} — measurement used.` : null,
    };
  }
  if (reading) {
    // A size the customer typed on an earlier test is contradicted by this reading: it
    // comes off the case rather than being priced as if it were true. Staff's own size stays.
    const typed = i.caseModelId === model && !!i.caseVariant && i.caseSource === "customer" && i.caseVariant !== reading;
    return {
      variant: null,
      source: null,
      flag: `Storage: phone measures ${reading}, not on file${said ? ` (customer said ${said} — not used)` : typed ? ` (customer's earlier ${i.caseVariant} removed)` : ""} — check Settings, then enter the partner's quote.`,
      ...(typed ? { clear: true as const } : {}),
    };
  }
  if (i.caseModelId === model && i.caseVariant) return none;
  if (i.variants.length === 1) return { variant: i.variants[0], source: "catalogue", flag: null };
  if (i.picked && i.picked.modelId === model && i.picked.variant && i.variants.includes(i.picked.variant)) {
    return {
      variant: i.picked.variant,
      source: "customer",
      flag: `Storage: customer said ${i.picked.variant}, not measured — check Settings › About phone.`,
    };
  }
  return none;
}

/* ─────────────────────────── storage, on a save ─────────────────────────── */

/**
 * Where the case's storage comes from after a save (updateCase), and whether the
 * size itself changed.
 *
 *   from   Apply's word — "measured", "catalogue" or "customer". Undefined = the
 *          public PATCH: staff, recorded as "advisor".
 *
 * Re-saving the size already on the case is not a new fact. From staff it keeps the
 * source it has: tapping the chip that is already pressed must not turn a size the
 * customer TYPED into the advisor's (that would drop the lock's "Settings › About
 * phone" tick on a size nobody checked), nor re-ask the partner, nor clear a quote
 * read off the partner's app. Apply's word still counts on the same size: a
 * measurement upgrades a claim. A size of a model that just changed is always new.
 */
export function storageOnSave(i: {
  next: string | null;
  prev: string | null;
  prevSource: VariantSource | null;
  from?: "measured" | "catalogue" | "customer";
  modelChanged: boolean;
}): { source: VariantSource | null; changed: boolean } {
  const changed = i.modelChanged || i.next !== i.prev;
  if (!i.next) return { source: null, changed };
  if (i.from) return { source: i.from, changed };
  return { source: !changed && i.prevSource ? i.prevSource : "advisor", changed };
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
  if (phase === "identify" && !camera) return "Phone identifying itself — scan code next.";
  if (phase === "scan" || (phase === "identify" && camera)) {
    if (!camera) {
      if (!s.unlocked) return s.locked ?? "Waiting for the phone's scan code…";
      return s.cameraAtWork
        ? "Camera at work — keep the phone facing it."
        : "Scan the phone's code, or Take photos.";
    }
    if (!s.screenDone) return "Photos in — screen check next; keep the phone facing it.";
    return s.gradeLine && s.gradeSettled ? s.gradeLine : "Photos and screen done — grade coming.";
  }
  if (phase === "colours") return "Phone showing test colours — tap what you see.";
  const where = phase === "done" ? "Tests done" : "Phone testing";
  if (camera) {
    if (s.gradeLine && s.gradeSettled) return `${s.gradeLine} ${where}.`;
    return `${where} — grade coming.`;
  }
  if (s.unlocked) return `${where} — no camera check; Take photos.`;
  return `${where} — no camera check; certify it or Take photos.`;
}

/** Why the camera page is still locked for a scan-first session (the phone isn't echoing its scan screen). */
export function scanFirstLock(phase: PhonePhase | null, cameraSkipped: boolean, sessionComplete: boolean): string {
  if (cameraSkipped || sessionComplete || (phase && phase !== "identify" && phase !== "scan"))
    return "Phone went on without the camera — photos need an override.";
  if (phase === "scan") return "Waiting for the phone's scan code…";
  return "Camera unlocks when the phone shows its scan code.";
}
