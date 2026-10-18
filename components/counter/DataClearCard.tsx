"use client";

import { useState } from "react";
import { Banner, ErrorText } from "@/components/ui";
import { DATA_CLEAR_STEPS, type DataClearStep } from "@/lib/domain/dataClear";
import { fmtWhen } from "./shared";
import type { CaseOps } from "./ops";

/** What the customer does on their own phone, in the order they do it. Shown to the advisor to read out. */
const GUIDE: { title: string; samsung: string; other: string }[] = [
  {
    title: "Back up",
    samsung: "Smart Switch to the new phone, or the cloud.",
    other: "Nothing can be recovered after the reset.",
  },
  {
    title: "Sign out of accounts",
    samsung: "Settings → Accounts and backup → Manage accounts → Samsung account → Sign out. Then Google → Remove account.",
    other: "Settings → Accounts → Google → Remove account. iPhone: Settings → their name → Sign Out.",
  },
  {
    title: "Factory reset",
    samsung: "Settings → General management → Reset → Factory data reset → Delete all.",
    other: "Settings → System → Reset options → Erase all data. iPhone: General → Transfer or Reset iPhone → Erase All.",
  },
  {
    title: "Wait for setup",
    samsung: "Tap through until it asks to connect or sign in.",
    other: "Asks for the old account? It wasn't removed — sign in and remove it.",
  },
];

/**
 * After the customer accepts: they clear their own phone, and the store records
 * what it saw. A record of a factory reset — never presented as a certified erasure.
 */
export function DataClearCard({ ops, canRecord }: { ops: CaseOps; canRecord: boolean }) {
  const { view, act, busy } = ops;
  const [ticks, setTicks] = useState<Record<DataClearStep, boolean>>({ accountsSignedOut: false, resetDone: false, setupScreenSeen: false, noPreviousAccount: false });
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const state = view.dataClearState;
  if (state === "not_applicable") return null;

  const rec = view.dataClear;
  const all = DATA_CLEAR_STEPS.every(([k]) => ticks[k]);

  async function save() {
    if (!all) return setErr("Tick each step you saw.");
    setErr(await act("data_clear", { steps: ticks, note: note.trim() || undefined }));
  }

  return (
    <section className="card" id="data-clear">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <h2 className="text-[17px] font-[720]">Clear the customer&apos;s data</h2>
        {state === "done" ? <span className="pill pill-up">Done</span> : state === "attested" ? <span className="pill">Ticked at hand-over</span> : <span className="pill pill-warn">To do</span>}
      </header>
      <div className="px-5 pb-5 pt-3 space-y-4">
        {state === "done" && rec ? (
          <>
            <Banner tone="up">
              Reset seen by {rec.by}, {fmtWhen(rec.at)}
              {rec.note ? <> · &ldquo;{rec.note}&rdquo;</> : null}
            </Banner>
            <p className="hint !mt-0">{rec.label}.</p>
          </>
        ) : state === "attested" ? (
          <p className="text-[14px] text-ink-2">Ticked at hand-over{view.checks ? ` by ${view.checks.by}` : ""} — not a certified erasure.</p>
        ) : (
          <>
            <p className="text-[14px] text-ink-2">The customer clears it — staff never handle passwords.</p>
            <ol className="space-y-2">
              {GUIDE.map((g, i) => (
                <li key={g.title} className="rounded-[10px] border border-line px-3 py-2.5">
                  <div className="font-semibold text-[14.5px]">
                    {i + 1}. {g.title}
                  </div>
                  <div className="text-[13.5px] text-ink-2 mt-0.5">
                    <span className="font-semibold">Samsung:</span> {g.samsung}
                  </div>
                  <div className="text-[13.5px] text-ink-2">
                    <span className="font-semibold">Others:</span> {g.other}
                  </div>
                </li>
              ))}
            </ol>

            {canRecord ? (
              <fieldset className="no-print">
                <legend className="label">What you saw</legend>
                <div className="space-y-2">
                  {DATA_CLEAR_STEPS.map(([k, label]) => (
                    <label key={k} className="flex items-start gap-3 rounded-[10px] border border-line px-3 py-2.5 cursor-pointer has-[:checked]:border-[color:var(--up)] has-[:checked]:bg-up-bg">
                      <input type="checkbox" className="mt-0.5 w-5 h-5 accent-[color:var(--up)]" checked={ticks[k]} onChange={(e) => setTicks((t) => ({ ...t, [k]: e.target.checked }))} />
                      <span className="text-[14.5px]">{label}</span>
                    </label>
                  ))}
                </div>
                <label className="block mt-3">
                  <span className="label">Note (optional)</span>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. kept the memory card" maxLength={200} />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" className="btn btn-primary" disabled={busy || !all} onClick={save}>
                    Record data cleared
                  </button>
                  <span className="hint !mt-0">Not a certified erasure.</span>
                </div>
                <ErrorText error={err} />
              </fieldset>
            ) : (
              <Banner tone="warn">Not recorded yet.</Banner>
            )}
            <p className="hint !mt-0">Not reset? Call them back — the partner rejects locked phones.</p>
          </>
        )}
      </div>
    </section>
  );
}
