"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText, Field, Money, SourceBadge } from "@/components/ui";
import { inr } from "@/lib/domain/money";

export type BookableDevice = { caseId: string; ref: string; label: string; value: number; days: number; sample: boolean };

/**
 * "Book a pickup": pick which waiting phones go on it (all by default), then
 * ask the partner to come. Lands on the new pickup.
 */
export function BookPickup({ devices, maxAgeDays, partnerName, primary }: { devices: BookableDevice[]; maxAgeDays: number; partnerName: string; primary: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(devices.map((d) => d.caseId)));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = devices.filter((d) => ticked.has(d.caseId));
  const total = chosen.reduce((t, d) => t + d.value, 0);
  const allOn = chosen.length === devices.length;

  const toggle = (id: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>("/api/pickups", { body: { caseIds: chosen.map((d) => d.caseId), notes: notes.trim() || null } });
      router.push(`/pickups/${p.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button type="button" className={`btn ${primary ? "btn-primary" : ""}`} onClick={() => setOpen(true)}>
        Book a pickup
      </button>
    );

  return (
    <form onSubmit={submit} className="card p-4 sm:p-5 space-y-4 w-full mt-3" aria-label="Book a pickup">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[16px] font-bold">Which phones should {partnerName} collect?</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTicked(allOn ? new Set() : new Set(devices.map((d) => d.caseId)))}>
          {allOn ? "Untick all" : "Tick all"}
        </button>
      </div>
      <fieldset className="card divide-y divide-[color:var(--line)] overflow-hidden">
        <legend className="sr-only">Phones waiting at the store</legend>
        {devices.map((d) => {
          const old = d.days >= maxAgeDays;
          return (
            <label key={d.caseId} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[color:var(--surface-2)]">
              <input type="checkbox" className="w-5 h-5 shrink-0 accent-[color:var(--ink)]" checked={ticked.has(d.caseId)} onChange={() => toggle(d.caseId)} />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold truncate">{d.label}</span>
                <span className="block text-[12.5px] text-muted">
                  <span className="num">{d.ref}</span> ·{" "}
                  <span className={old ? "text-warn font-semibold" : undefined}>
                    {d.days === 0 ? "taken in today" : `${d.days} ${d.days === 1 ? "day" : "days"} at the store`}
                    {old ? ` (over ${maxAgeDays})` : ""}
                  </span>
                </span>
              </span>
              <span className="flex flex-col items-end gap-1 shrink-0">
                <Money value={d.value} className="font-semibold" />
                {d.sample ? <SourceBadge kind="sample" /> : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <Field label="Note for the collector (optional)" hint="e.g. Collect after 2 pm; ask for the service desk.">
        <input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || chosen.length === 0}>
          {busy ? "Booking…" : `Request pickup · ${chosen.length} ${chosen.length === 1 ? "phone" : "phones"} · ${inr(total)}`}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          Not now
        </button>
      </div>
      <p className="hint mt-0!">Phones you leave unticked stay waiting at the store and can go on a later pickup.</p>
      <ErrorText error={error} />
    </form>
  );
}
