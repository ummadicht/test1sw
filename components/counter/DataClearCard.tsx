"use client";

import { useState } from "react";
import { Banner, ErrorText } from "@/components/ui";
import { DATA_CLEAR_STEPS, type DataClearStep } from "@/lib/domain/dataClear";
import { fmtWhen } from "./shared";
import type { CaseOps } from "./ops";

/** What the customer does on their own phone, in the order they do it. Shown to the advisor to read out. */
const GUIDE: { title: string; samsung: string; other: string }[] = [
  {
    title: "Back up anything they want to keep",
    samsung: "Photos and chats to their new phone (Smart Switch) or the cloud.",
    other: "Same — once the phone is reset, nothing on it can be recovered.",
  },
  {
    title: "Sign out of their accounts",
    samsung: "Settings → Accounts and backup → Manage accounts → their Samsung account → Sign out (needs its password). Then the Google account → Remove account.",
    other: "Settings → Passwords & accounts (or Accounts) → their Google account → Remove account. On an iPhone: Settings → their name → Sign Out.",
  },
  {
    title: "Factory reset",
    samsung: "Settings → General management → Reset → Factory data reset → Reset → Delete all.",
    other: "Settings → System → Reset options → Erase all data. On an iPhone: Settings → General → Transfer or Reset iPhone → Erase All Content and Settings.",
  },
  {
    title: "Wait for the setup screen",
    samsung: "The phone restarts to a Welcome screen. Tap through setup until it asks to connect or sign in.",
    other: "If setup asks for the previous owner's Google account or Apple ID, the account was not removed — the customer must sign in and remove it.",
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
    if (!all) return setErr("Tick each step once you have seen it on the phone.");
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
              Reset seen by {rec.by}, {fmtWhen(rec.at)}. The phone came back to its setup screen without asking for the customer&apos;s account.
              {rec.note ? <> Note: &ldquo;{rec.note}&rdquo;</> : null}
            </Banner>
            <p className="hint !mt-0">{rec.label}.</p>
          </>
        ) : state === "attested" ? (
          <p className="text-[14px] text-ink-2">
            This trade-in was taken before data clearing became its own step. The factory reset and account sign-out were ticked with the hand-over checks
            {view.checks ? ` by ${view.checks.by}` : ""}. Factory reset by the customer — not a certified erasure.
          </p>
        ) : (
          <>
            <p className="text-[14px] text-ink-2">
              The customer has accepted. Before they leave, they clear their own phone from its Settings — staff never handle the customer&apos;s passwords.
              Read these steps out, then tick what you see on the phone.
            </p>
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
            <p className="hint !mt-0">
              The SwapUp Check app is deleted with everything else — that&apos;s expected; its test results are already saved on this case.
            </p>

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
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. customer kept the memory card" maxLength={200} />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" className="btn btn-primary" disabled={busy || !all} onClick={save}>
                    Record data cleared
                  </button>
                  <span className="hint !mt-0">Factory reset by the customer, seen by you — not a certified erasure.</span>
                </div>
                <ErrorText error={err} />
              </fieldset>
            ) : (
              <Banner tone="warn">Not recorded yet — the store records it while the customer is at the counter.</Banner>
            )}
            <p className="hint !mt-0">
              If the customer leaves without resetting, call them back: a phone that still asks for their account can&apos;t be set up by anyone else, and the
              partner will reject it.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
