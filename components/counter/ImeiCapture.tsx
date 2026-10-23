"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner } from "@/components/ui";
import type { CaseView } from "@/lib/server/cases";
import { NOTHING_READ, READ_FAILS_CHECK, imeiFound, readImeiRead, readLine, type ImeiRead } from "./imeiFirst";

/**
 * The desk's IMEI pieces (SUP-35), shared by New trade-in (NewCaseForm) and the case's Phone step
 * (StepPhone); the rules are imeiFirst.ts's.
 *
 *   ReadTheScreen  "Read the screen": a photo of the customer's *#06# screen (the tablet's camera, or
 *                  a file) → POST /api/imei/read. The answer waits for Confirm — never trusted by
 *                  itself; a read that fails its check digit goes into the field to be put right.
 *   ImeiResult     what the server found for the case's IMEI, before any test: the model and GSMA's
 *                  word, its warnings (an IMEI already on another trade-in), and the stop banner.
 */

/** Photos are sent at most this wide or tall: an IMEI stays legible, and the upload stays small. */
const MAX_SIDE = 1600;

/** The photo as a JPEG data URL, scaled down when it is big; the file as it is when it can't be drawn. */
async function photoDataUrl(file: File): Promise<string> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL("image/jpeg", 0.88);
  } catch {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("That photo couldn't be opened — take it again."));
      r.readAsDataURL(file);
    });
  }
}

export function ReadTheScreen({
  disabled,
  onConfirm,
  onMisread,
}: {
  disabled?: boolean;
  /** The advisor checked the read against the screen. */
  onConfirm: (v: { imei: string; imei2: string | null }) => void;
  /** A read to put right by hand (it fails its check digit, or the advisor said "Not right"). */
  onMisread: (imei: string) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<ImeiRead | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function take(f: File | undefined) {
    if (!f) return;
    setReading(true);
    setRead(null);
    setNote(null);
    try {
      const r = readImeiRead(await api<unknown>("/api/imei/read", { body: { photo: await photoDataUrl(f) } }));
      if (!r) setNote(NOTHING_READ);
      else if (r.valid) setRead(r);
      else {
        onMisread(r.imei);
        setNote(READ_FAILS_CHECK);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setReading(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-sm" disabled={disabled || reading} onClick={() => file.current?.click()}>
        {reading ? "Reading…" : "Read the screen"}
      </button>
      <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void take(e.target.files?.[0])} />
      {read ? (
        <div className="rounded-[12px] border border-line bg-surface-2 px-3.5 py-2.5 space-y-2">
          <p className="text-[14px] text-ink leading-snug num">{readLine(read)}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={disabled}
              onClick={() => {
                onConfirm({ imei: read.imei, imei2: read.imei2 });
                setRead(null);
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                onMisread(read.imei);
                setRead(null);
              }}
            >
              Not right
            </button>
          </div>
        </div>
      ) : null}
      {note ? <p className="hint !mt-0 text-warn">{note}</p> : null}
    </div>
  );
}

const TONE: Record<"up" | "warn" | "bad", string> = { up: "text-up", warn: "text-warn", bad: "text-bad" };

/** What the server found for the case's IMEI — the model and GSMA's word, the warnings, the stop. */
export function ImeiResult({ view }: { view: Pick<CaseView, "imei" | "imeiCheck" | "imeiLookup" | "imeiWarnings" | "kymEarly" | "modelSource"> }) {
  const f = imeiFound(view);
  if (!f.line && !f.warnings.length && !f.stop) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {f.line ? <p className={`text-[15px] font-semibold leading-snug ${TONE[f.tone]}`}>{f.line}</p> : null}
      {f.stop ? (
        <Banner tone="bad">
          <div className="font-semibold">Do not take it</div>
          {f.stop}
        </Banner>
      ) : null}
      {f.warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
    </div>
  );
}
