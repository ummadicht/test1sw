import { readScreen, readSnapshot, publicPhotoUrl, type GiqScreen, type GradeiqSnapshot } from "../domain/gradeiqMap";

/**
 * GRADEIQ — the grading engine underneath SwapUp Check (server to server).
 *
 * SwapUp's server is the ONLY thing that calls GradeIQ's API. The camera page
 * (`cameraUrl`) is opened by the store device. Since SwapUp Check 0.6.0 the
 * customer's phone also SHOWS that link as its scan code, the way GradeIQ v2
 * does (owner's decision, 2026-10-17, docs/PHONE-LED-FLOW.md) — so for those
 * sessions the GradeIQ id is on the customer's phone, and whoever holds the
 * link can write to the GradeIQ session and open its /report. Older apps never
 * see it. Contract: docs/GRADEIQ-INTEGRATION.md.
 *
 *   GRADEIQ_BASE_URL    where this server reaches GradeIQ (same VM in production,
 *                       so no public proxy hops). The basePath is compiled into
 *                       GradeIQ, so /apps/gradeiq is part of it in production.
 *   GRADEIQ_PUBLIC_URL  what a staff device opens (camera page, photos).
 *   GRADEIQ_CLIENT      the GradeIQ tenant. "swapmore-in" (INR) until GradeIQ
 *                       has a dedicated swapup tenant; GradeIQ silently turns an
 *                       unknown id into "default" (EUR), so the echoed client
 *                       is checked on every create.
 *   GRADEIQ_CHANNEL     the journey channel ("retail" — the capture journey the
 *                       retail desk already exercises).
 *   GRADEIQ_ENABLED     "1" (default) or "0" — a LABELLED kill switch back to
 *                       the advisor checking condition by eye. Not a demo mode:
 *                       there is no demo or fallback grade anywhere, and no
 *                       variable that could turn one on.
 *
 * Calls SwapUp never makes: /offer, /accept, /value, /grade-manual, /reprocess
 * (a price, a paid Phonecheck lookup, an anonymous grade overwrite). And no
 * IMEI is ever sent at create — every create with a 15-digit IMEI makes paid
 * Phonecheck calls.
 */

export type GradeiqConfig = {
  enabled: boolean;
  baseUrl: string;
  publicUrl: string;
  client: string;
  channel: string;
  createTimeoutMs: number;
  timeoutMs: number;
  /** Call 7 (/ocr) is one vision-model read of a screenshot, and answers with the whole session. */
  ocrTimeoutMs: number;
};

export function gradeiqConfig(): GradeiqConfig {
  const e = process.env;
  const ms = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    enabled: (e.GRADEIQ_ENABLED ?? "1").trim() !== "0",
    baseUrl: (e.GRADEIQ_BASE_URL || "http://127.0.0.1:3700/apps/gradeiq").replace(/\/$/, ""),
    publicUrl: (e.GRADEIQ_PUBLIC_URL || "https://swapmore.com/apps/gradeiq").replace(/\/$/, ""),
    client: (e.GRADEIQ_CLIENT || "swapmore-in").trim(),
    channel: (e.GRADEIQ_CHANNEL || "retail").trim(),
    createTimeoutMs: ms(e.GRADEIQ_CREATE_TIMEOUT_MS, 20_000),
    timeoutMs: ms(e.GRADEIQ_TIMEOUT_MS, 5_000),
    ocrTimeoutMs: ms(e.GRADEIQ_OCR_TIMEOUT_MS, 30_000),
  };
}

export type GradeiqErrorKind = "disabled" | "timeout" | "network" | "http" | "not_found" | "tenant" | "shape";

export class GradeiqError extends Error {
  kind: GradeiqErrorKind;
  status: number | null;
  /** The request may have reached GradeIQ (a timeout): a create might have happened. */
  ambiguous: boolean;
  /** A GradeIQ session that was made but will not be used (e.g. under the wrong tenant). */
  orphanId: string | null;
  constructor(kind: GradeiqErrorKind, message: string, opts: { status?: number | null; ambiguous?: boolean; orphanId?: string | null } = {}) {
    super(message);
    this.name = "GradeiqError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.ambiguous = opts.ambiguous ?? false;
    this.orphanId = opts.orphanId ?? null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionPath(id: string, rest = ""): string {
  if (!UUID.test(id)) throw new GradeiqError("shape", "Not a GradeIQ session id.");
  return `/api/sessions/${id}${rest}`;
}

/**
 * One request with its own timeout. `read: false` discards the body without
 * downloading it: several GradeIQ routes echo the whole session back, and the
 * session carries base64 copies of every photo once they are taken.
 */
async function call(path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number; read?: boolean } = {}): Promise<unknown> {
  const cfg = gradeiqConfig();
  if (!cfg.enabled) throw new GradeiqError("disabled", "Camera grading is switched off (GRADEIQ_ENABLED=0).");
  const ctl = new AbortController();
  const timeout = init.timeoutMs ?? cfg.timeoutMs;
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctl.signal,
      cache: "no-store",
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new GradeiqError("timeout", `GradeIQ did not answer within ${Math.round(timeout / 1000)} s.`, { ambiguous: init.method === "POST" });
    throw new GradeiqError("network", `Can't reach GradeIQ (${(e as Error).message || "network error"}).`);
  }
  try {
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new GradeiqError("not_found", "GradeIQ does not know this session.", { status: 404 });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new GradeiqError("http", `GradeIQ answered ${res.status}.`, { status: res.status });
    }
    if (init.read === false) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    try {
      return await res.json();
    } catch {
      if (ctl.signal.aborted) throw new GradeiqError("timeout", `GradeIQ did not finish answering within ${Math.round(timeout / 1000)} s.`);
      throw new GradeiqError("shape", "GradeIQ sent something that is not JSON.");
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── the calls (contract §1, calls 1–6) ─────────────────────────── */

/**
 * Call 1 — a new GradeIQ session. No IMEI, ever (paid Phonecheck lookups); the
 * model label only when the case already has one. Rejects a create whose
 * echoed tenant is not GRADEIQ_CLIENT (an unknown tenant silently becomes
 * GradeIQ's EUR "default").
 */
export async function createSession(input: { model?: string | null } = {}): Promise<{ id: string; client: string }> {
  const cfg = gradeiqConfig();
  const body: Record<string, string> = { client: cfg.client, channel: cfg.channel, segment: "c2b" };
  if (input.model) body.model = input.model.slice(0, 80);
  const r = (await call("/api/sessions", { method: "POST", body, timeoutMs: cfg.createTimeoutMs })) as { id?: unknown; client?: unknown } | null;
  const id = typeof r?.id === "string" ? r.id : "";
  const client = typeof r?.client === "string" ? r.client : "";
  if (!UUID.test(id)) throw new GradeiqError("shape", "GradeIQ did not return a session id.");
  if (client !== cfg.client) {
    throw new GradeiqError("tenant", `GradeIQ put this session under tenant "${client || "?"}", not "${cfg.client}". No GradeIQ data will be used — check GRADEIQ_CLIENT.`, { orphanId: id });
  }
  return { id, client };
}

export type DeviceForward = {
  device: { source: "swapup-check"; brand?: string; model?: string; os?: string; storageGB?: number; imei?: string };
  model?: string;
};

/** Call 2 — what the phone says about itself. GradeIQ runs no IMEI lookup on this route. */
export async function postDevice(id: string, body: DeviceForward): Promise<void> {
  await call(sessionPath(id, "/device"), { method: "POST", body, read: false });
}

/**
 * Call 3 — the FULL functional map, always with merge:true. A body without
 * `functional` or without `merge` wipes every stored result in GradeIQ.
 */
export async function postFunctional(id: string, functional: Record<string, "pass" | "fail" | "skip">): Promise<void> {
  if (!functional || typeof functional !== "object") throw new GradeiqError("shape", "Nothing to forward.");
  await call(sessionPath(id, "/functional"), { method: "POST", body: { functional, merge: true }, read: false });
}

/** Call 4 — the light pairing poll. An unknown id reads "idle", not 404. */
export async function getScreen(id: string): Promise<GiqScreen> {
  return readScreen(await call(sessionPath(id, "/screen")));
}

/** Call 4 — the customer's phone echoes which pattern it is actually showing. */
export async function postScreenShown(id: string, shown: string): Promise<void> {
  await call(sessionPath(id, "/screen"), { method: "POST", body: { shown }, read: false });
}

/**
 * Call 5 — the whole session, reduced to the snapshot SwapUp keeps. `staged`
 * (base64 photos) and `offer` (a price) are dropped by construction. A session
 * under another tenant is refused.
 */
export async function getSession(id: string, fetchedAt: string): Promise<GradeiqSnapshot> {
  const cfg = gradeiqConfig();
  const raw = (await call(sessionPath(id))) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new GradeiqError("shape", "GradeIQ sent an empty session.");
  delete raw.staged;
  delete raw.offer;
  const snap = readSnapshot(raw, cfg.publicUrl, fetchedAt);
  // Strict: a session that names no tenant is not proven to be ours (GradeIQ always stores client_id).
  if (snap.client !== cfg.client) throw new GradeiqError("tenant", `This GradeIQ session belongs to tenant "${snap.client || "?"}", not "${cfg.client}".`);
  return snap;
}

/**
 * Call 6 — the DeviceFax JSON (signed; no price, no `staged`), for staff only.
 * Its photo URLs are built from the request's own origin (127.0.0.1 on the
 * VM), so they are re-rooted on GRADEIQ_PUBLIC_URL.
 */
export async function exportDeviceFax(id: string): Promise<Record<string, unknown>> {
  const cfg = gradeiqConfig();
  if (!UUID.test(id)) throw new GradeiqError("shape", "Not a GradeIQ session id.");
  const fax = (await call(`/api/report/${id}/export`)) as Record<string, unknown> | null;
  if (!fax || typeof fax !== "object" || Array.isArray(fax)) throw new GradeiqError("shape", "GradeIQ sent an empty DeviceFax.");
  delete fax.offer;
  delete fax.staged;
  if (Array.isArray(fax.photos)) fax.photos = (fax.photos as unknown[]).map((p) => publicPhotoUrl(p, cfg.publicUrl)).filter(Boolean);
  return fax;
}

/**
 * Call 7 — GradeIQ reads a battery-health screenshot (SwapUp Check ≥ 0.6.0,
 * docs/PHONE-LED-FLOW.md). GradeIQ's /ocr is its Settings-screen reader: one
 * vision call over the frames, then it answers with `ocr` AND the whole session
 * (photos and all), so it gets its own, longer timeout. → the % read, or null
 * when nothing legible came back (no vision key, a blurry shot, the wrong
 * screen). Side effects on GradeIQ's side, by its design: the screenshot is kept
 * in its public uploads, and an IMEI legible in the shot replaces the session's
 * IMEI and runs GradeIQ's IMEI lookup (a paid Phonecheck check) — the battery
 * screens the app points the customer at don't show one.
 */
export async function readBatteryHealth(id: string, image: string): Promise<number | null> {
  const cfg = gradeiqConfig();
  const r = (await call(sessionPath(id, "/ocr"), { method: "POST", body: { frames: [image], kind: "battery" }, timeoutMs: cfg.ocrTimeoutMs })) as {
    ocr?: { batteryHealth?: unknown } | null;
  } | null;
  const pct = Number(r?.ocr?.batteryHealth);
  return Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct) : null;
}

/**
 * One of the two camera passes (docs/TWO-PASS-CAMERA.md):
 *   photos  the exterior photos and the cosmetic grade — needs nothing on the
 *           customer's phone, so it can run before the phone has joined.
 *   screen  the LCD sweep only — needs SwapUp Check on the customer's phone,
 *           showing its photo screen after the tests.
 */
export type CameraPass = "photos" | "screen";

/**
 * The camera page the STORE device opens. The id is the only key to the
 * session. No `pass` = GradeIQ's original single pass (photos, sweep and
 * Settings photo in one go): what SwapUp Store ≤ 0.4.x opens, and what SwapUp
 * Check ≥ 0.6.0 shows as its scan code (GET /api/device/camera-link).
 */
export function cameraUrl(id: string, pass?: CameraPass): string {
  return `${gradeiqConfig().publicUrl}/v2/cam/${id}${pass ? `?pass=${pass}` : ""}`;
}
