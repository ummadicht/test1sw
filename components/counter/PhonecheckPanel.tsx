"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";
import type { CaseView } from "@/lib/server/cases";
import type { Role } from "@/lib/server/auth";
import type { PcSummary } from "@/lib/server/phonecheck";
import type { CaseOps } from "./ops";
import { checkUpload, extractedRows, mismatchOf, overrideReasonOk, pcRecordLine, readJsonUpload } from "./gradingView";

/**
 * PHONECHECK ON THE CASE (docs/GRADING.md) — the ways a Phonecheck result
 * reaches the case, behind the "What's wrong" step's "Show details" (it changes the faults):
 *
 *   Phonecheck results   pull the station's newest check of this IMEI — only
 *                        when the server has Phonecheck switched on (it ships
 *                        off: the hint says why it isn't there);
 *   Phonecheck JSON      the station's JSON export, uploaded — always works;
 *   Report PDF or photo  the report itself, read by AI into the same record —
 *                        always provisional, and what it read is shown here to
 *                        check against the paper. When the AI reader is off
 *                        (no key, or its account out of credit) the server says
 *                        why and the button waits; the JSON upload still works.
 *
 * A report for another IMEI comes back 409 with the stored record: the store
 * manager can attach it with a reason (the grade then says so); an advisor is
 * told to ask. The grade itself is one line on the answer (GradeRow); nothing
 * here is money, and the grade never moves a price.
 *
 * Store staff only, while the case is at the counter.
 */

type PcResult = { case: CaseView; record: PcSummary | null; outcome: "attached" | "not_found" | "stale"; note: string | null; extracted?: Record<string, unknown> };
type PcInfo = {
  configured: { ok: boolean; why: string };
  station: string | null;
  stationFrom: "store" | "server" | null;
  canPull: boolean;
  why: string | null;
  /** Can a PDF / photo of the report be read by AI here right now? Older servers don't say. */
  aiReader?: { ok: boolean; why: string };
  records: PcSummary[];
};

const COUNTER: Role[] = ["advisor", "store_manager"];

/** POST /api/cases/<id>/phonecheck — JSON or multipart; the status and body, whatever they are (a 409 mismatch carries data). */
async function postPhonecheck(caseId: string, body: FormData | Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  const form = body instanceof FormData;
  const res = await fetch(`/api/cases/${caseId}/phonecheck`, {
    method: "POST",
    headers: form ? undefined : { "content-type": "application/json" },
    body: form ? body : JSON.stringify(body),
    cache: "no-store",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 401) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  return { status: res.status, data };
}

export function PhonecheckPanel({
  ops,
  role,
  run,
}: {
  ops: CaseOps;
  role: Role;
  /** The workspace's serialised save queue: the case a Phonecheck call returns replaces the one on screen, in order with every other save. */
  run: (fn: () => Promise<CaseView>) => Promise<string | null>;
}) {
  const { view } = ops;
  const id = view.id;
  /** Can "Phonecheck results" be pressed, and why not — the server's (CaseView.grading.phonecheck). */
  const pull = view.grading?.phonecheck ?? null;
  const canAttach = ops.editable && COUNTER.includes(role);
  const isManager = role === "store_manager";

  const [pc, setPc] = useState<PcInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<Record<string, unknown> | null>(null);
  const [mismatch, setMismatch] = useState<{ error: string; record: PcSummary } | null>(null);
  const [reason, setReason] = useState("");
  const jsonInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadPc = useCallback(() => {
    if (!canAttach) return;
    api<PcInfo>(`/api/cases/${id}/phonecheck`)
      .then(setPc)
      .catch(() => setPc(null));
  }, [id, canAttach]);
  useEffect(loadPc, [loadPc]);

  if (!canAttach) return null;

  async function send(body: FormData | Record<string, unknown>, what: string) {
    setBusy(what);
    setErr(null);
    setNote(null);
    setExtracted(null);
    setMismatch(null);
    const box: { out: PcResult | null; mm: { error: string; record: PcSummary } | null } = { out: null, mm: null };
    const fail = await run(async () => {
      const { status, data } = await postPhonecheck(id, body);
      if (status >= 200 && status < 300) {
        box.out = data as PcResult;
        return box.out.case;
      }
      box.mm = mismatchOf(status, data);
      throw new Error((data as { error?: string } | null)?.error || `Request failed (${status})`);
    });
    setBusy(null);
    if (box.mm) {
      setMismatch(box.mm);
      setReason("");
    } else if (fail) setErr(fail);
    const out = box.out;
    if (out) {
      setNote(
        out.note ??
          (out.outcome === "attached"
            ? "Added — faults and grade updated."
            : out.outcome === "not_found"
              ? "No Phonecheck test of this phone."
              : "Nothing new.")
      );
      if (out.extracted) setExtracted(out.extracted);
    }
    loadPc();
  }

  async function onJson(file: File | undefined) {
    if (!file) return;
    const ok = checkUpload(file, "json");
    if (!ok.ok) return setErr(ok.reason);
    const parsed = readJsonUpload(await file.text());
    if (!parsed.ok) return setErr(parsed.reason);
    await send({ mode: "upload", record: parsed.record }, "json");
  }

  async function onReport(file: File | undefined) {
    if (!file) return;
    const ok = checkUpload(file, "report");
    if (!ok.ok) return setErr(ok.reason);
    const form = new FormData();
    form.set("file", file, file.name);
    await send(form, "report");
  }

  // The AI reader is off (no key, or out of credit): the server says why — before a file is chosen, not after a refusal.
  const aiOff = pc?.aiReader && !pc.aiReader.ok ? pc.aiReader.why : null;
  const others = (pc?.records ?? []).filter((r) => r.attached?.caseId !== id).slice(0, 5);
  const onCase = (pc?.records ?? []).find((r) => r.attached?.caseId === id) ?? null;

  return (
    <section className="rounded-[12px] border border-line no-print" id="phonecheck" aria-labelledby="phonecheck-title">
      <div className="px-4 py-3.5">
        <h2 id="phonecheck-title" className="section-title">
          Phonecheck
        </h2>
        <div className="flex flex-wrap gap-2 mt-2">
          {pull?.canPull ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => send({ mode: "pull" }, "pull")}>
              {busy === "pull" ? "Asking Phonecheck…" : "Phonecheck results"}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => jsonInput.current?.click()}>
            {busy === "json" ? "Adding…" : "Upload Phonecheck JSON"}
          </button>
          <button type="button" className="btn btn-sm" disabled={!!busy || !!aiOff} title={aiOff ?? undefined} onClick={() => fileInput.current?.click()}>
            {busy === "report" ? "Reading…" : "Report PDF or photo"}
          </button>
          <input
            ref={jsonInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              void onJson(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              void onReport(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {!pull?.canPull && pull?.why ? <p className="hint">Phonecheck look-up: {pull.why}</p> : null}
        {aiOff ? (
          <p className="hint">Report PDF or photo: {aiOff}</p>
        ) : (
          <p className="hint">Read by AI, up to 8 MB — check it against the paper.</p>
        )}

        {onCase ? <p className="text-[13px] text-ink-2 mt-2">On this case: {pcRecordLine(onCase)}</p> : null}
        {others.length ? (
          <div className="mt-2">
            <div className="text-[12.5px] font-semibold text-muted">Other checks of this phone</div>
            <ul className="mt-1 space-y-1.5">
              {others.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    {pcRecordLine(r)}
                    {r.attached ? <span className="text-muted"> · on case {r.attached.caseRef ?? r.attached.caseId}</span> : null}
                  </span>
                  {/* One on a case the customer left can move here; the server refuses (and says which case) while that case still holds the phone. */}
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => send({ mode: "attach", recordId: r.id }, "attach")}>
                    Add here
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {mismatch ? (
          <div className="banner banner-warn mt-3" role="alert">
            <span aria-hidden>⚠</span>
            <div className="min-w-0 flex-1 space-y-2">
              <div>{mismatch.error}</div>
              <div className="text-[13px]">{pcRecordLine(mismatch.record)}</div>
              {isManager ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="label">How you checked</span>
                    <input
                      className="input"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={300}
                      placeholder="e.g. dialled *#06#"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!!busy || !overrideReasonOk(reason)}
                      onClick={() => send({ mode: "attach", recordId: mismatch.record.id, confirmMismatch: true, reason: reason.trim() }, "attach")}
                    >
                      Attach anyway
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMismatch(null)}>
                      Cancel
                    </button>
                  </div>
                  <p className="hint !mt-0">The report will show this.</p>
                </div>
              ) : (
                <div className="text-[13px] font-semibold">Ask your manager to attach it.</div>
              )}
            </div>
          </div>
        ) : null}

        {note ? (
          <div className="banner banner-up mt-3">
            <span aria-hidden>✓</span>
            <div>{note}</div>
          </div>
        ) : null}
        {extracted ? (
          <div className="mt-3 rounded-[11px] border border-line">
            <div className="px-3.5 pt-2.5 text-[13px] font-semibold">AI read — check it</div>
            <dl className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13px]">
              {extractedRows(extracted).map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className={`min-w-0 break-words ${r.read ? "" : "text-warn"}`}>{r.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        <ErrorText error={err} />
      </div>
    </section>
  );
}

