"use client";

/**
 * Every write on a pickup, one component per step. Each posts to
 * /api/pickups/[id]/action and refreshes the server-rendered page, so the
 * timeline, totals and credit figures always come from the services.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText, Field, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import { OUTCOME_LABEL, type ClearanceOutcome } from "@/lib/domain/lifecycle";

type Item = { id: string; ref: string; device: string | null; tradeValue: number | null };

function useAction(pickupId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pickups/${pickupId}/action`, { body: payload });
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/* ── partner: book the collection slot ─────────────────────────── */

export function ScheduleForm({ pickupId, defaultWhen, defaultCollector }: { pickupId: string; defaultWhen: string; defaultCollector: string }) {
  const { busy, error, run } = useAction(pickupId);
  const [when, setWhen] = useState(defaultWhen);
  const [collector, setCollector] = useState(defaultCollector);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const d = new Date(when);
    void run({ action: "schedule", scheduledFor: Number.isNaN(d.getTime()) ? "" : d.toISOString(), collectorName: collector });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Collection time">
          <input className="input" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Collector's name" hint="Checked at handover.">
          <input className="input" required minLength={2} maxLength={80} value={collector} onChange={(e) => setCollector(e.target.value)} placeholder="e.g. Sunil K." />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy || !when || collector.trim().length < 2}>
        {busy ? "Booking…" : "Book collection"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

/* ── store or partner: the handover at the counter ─────────────── */

export function HandoverForm({
  pickupId,
  items,
  defaultCollector,
  defaultHandoverBy,
  releaseOn,
  partnerName,
  viewer,
}: {
  pickupId: string;
  items: Item[];
  defaultCollector: string;
  defaultHandoverBy: string;
  releaseOn: "collected" | "cleared";
  partnerName: string;
  viewer: "store_manager" | "partner";
}) {
  const { busy, error, run } = useAction(pickupId);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [collector, setCollector] = useState(defaultCollector);
  const [handover, setHandover] = useState(defaultHandoverBy);
  const taking = items.filter((i) => ticked.has(i.id));
  const value = taking.reduce((t, i) => t + (i.tradeValue ?? 0), 0);
  const left = items.length - taking.length;
  const toggle = (id: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run({ action: "collect", collectedCaseIds: taking.map((i) => i.id), collectorName: collector, handoverBy: handover });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-[14.5px] text-ink-2 leading-relaxed">Tick only the phones being taken.</p>
      <fieldset className="card divide-y divide-[color:var(--line)] overflow-hidden">
        <legend className="sr-only">Phones handed over</legend>
        {items.map((i) => (
          <label key={i.id} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[color:var(--surface-2)]">
            <input type="checkbox" className="w-5 h-5 accent-[color:var(--ink)]" checked={ticked.has(i.id)} onChange={() => toggle(i.id)} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold truncate">{i.device ?? "No phone recorded"}</span>
              <span className="block text-[12.5px] text-muted num">{i.ref}</span>
            </span>
            <span className="flex flex-col items-end gap-1">
              <Money value={i.tradeValue} className="font-semibold" />
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Collector's name" hint={viewer === "store_manager" ? "Check their ID." : undefined}>
          <input className="input" required minLength={2} maxLength={80} value={collector} onChange={(e) => setCollector(e.target.value)} />
        </Field>
        <Field label="Handed over by">
          <input className="input" required minLength={2} maxLength={80} value={handover} onChange={(e) => setHandover(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-up" disabled={busy || taking.length === 0 || collector.trim().length < 2 || handover.trim().length < 2}>
          {busy ? "Recording…" : `Confirm handover · ${taking.length} ${taking.length === 1 ? "phone" : "phones"} · ${inr(value)}`}
        </button>
        {left > 0 ? (
          <span className="hint mt-0!">{left} stay at the store.</span>
        ) : null}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/* ── partner: the verdict on one phone ─────────────────────────── */

const OUTCOMES: ClearanceOutcome[] = ["cleared", "regraded", "rejected", "not_received"];

export function VerdictForm({ pickupId, item, storeCarriesShortfall }: { pickupId: string; item: Item; storeCarriesShortfall: boolean }) {
  const { busy, error, run } = useAction(pickupId);
  const quoted = item.tradeValue ?? 0;
  const [outcome, setOutcome] = useState<ClearanceOutcome>("cleared");
  const [accepted, setAccepted] = useState(String(quoted));
  const [reason, setReason] = useState("");
  const acceptedNum = Math.floor(Number(accepted));
  const regradeOk = outcome !== "regraded" || (Number.isFinite(acceptedNum) && acceptedNum >= 0 && acceptedNum < quoted);
  const reasonOk = outcome === "cleared" || reason.trim().length >= 6;
  const pays = outcome === "cleared" ? quoted : outcome === "regraded" ? (Number.isFinite(acceptedNum) ? acceptedNum : 0) : 0;
  const shortfall = Math.max(0, quoted - pays);
  const carried = outcome === "not_received" || storeCarriesShortfall;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run({ action: "clear", caseId: item.id, outcome, accepted: outcome === "regraded" ? acceptedNum : undefined, reason: reason.trim() || undefined });
  };
  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">{item.device ?? "No phone recorded"}</div>
          <div className="text-[12.5px] text-muted num">{item.ref}</div>
        </div>
        <div className="text-right">
          <div className="text-[12px] text-muted">Quoted</div>
          <Money value={item.tradeValue} className="font-semibold" />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Verdict">
          <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value as ClearanceOutcome)}>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </Field>
        {outcome === "regraded" ? (
          <Field
            label="You pay (₹)"
            hint={regradeOk ? undefined : "Below the quote — or choose Cleared."}
          >
            <input className="input num" inputMode="numeric" value={accepted} onChange={(e) => setAccepted(e.target.value.replace(/[^\d]/g, ""))} />
          </Field>
        ) : null}
      </div>
      {outcome !== "cleared" ? (
        <Field label="Reason" hint="The store sees this.">
          <textarea
            className="textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              outcome === "regraded"
                ? "e.g. Back glass cracked, not declared"
                : outcome === "rejected"
                  ? "e.g. Account lock still on"
                  : "e.g. Missing from the sealed bag"
            }
          />
        </Field>
      ) : null}
      <p className="text-[13.5px] text-ink-2">
        {outcome === "cleared" ? (
          <>Paid in full.</>
        ) : (
          <>
            You pay <strong>{inr(pays)}</strong> · shortfall <strong>{inr(shortfall)}</strong>{" "}
            {outcome === "not_received" ? "(disputed)" : carried ? "(store's line)" : "(partner carries)"}
            {outcome === "rejected" ? " · phone goes back" : ""}
          </>
        )}
      </p>
      <button className="btn btn-primary btn-sm" disabled={busy || !regradeOk || !reasonOk}>
        {busy ? "Saving…" : "Record verdict"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

/* ── partner: pay the store ─────────────────────────────────────── */

export function SettleForm({ pickupId, amount, storeName }: { pickupId: string; amount: number; storeName: string }) {
  const { busy, error, run } = useAction(pickupId);
  const [reference, setReference] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run({ action: "settle", reference });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4 items-start">
        <div>
          <span className="label">To pay {storeName}</span>
          <div className="kpi">
            <Money value={amount} />
          </div>
          <span className="hint">Fixed by your verdicts.</span>
        </div>
        <Field label="Payment ref (UTR)">
          <input className="input num" required minLength={4} maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. UTR 4321…" />
        </Field>
      </div>
      <button className="btn btn-up" disabled={busy || reference.trim().length < 4}>
        {busy ? "Saving…" : "Mark settled"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

/* ── small one-click actions ────────────────────────────────────── */

export function RemoveItemButton({ pickupId, caseId, caseRef }: { pickupId: string; caseId: string; caseRef: string }) {
  const { busy, error, run } = useAction(pickupId);
  return (
    <div>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Take ${caseRef} off this pickup?`)) void run({ action: "remove", caseId });
        }}
      >
        {busy ? "Removing…" : "Take off"}
      </button>
      <ErrorText error={error} />
    </div>
  );
}

export function CancelPickupButton({ pickupId, count }: { pickupId: string; count: number }) {
  const { busy, error, run } = useAction(pickupId);
  return (
    <div>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Cancel this pickup? ${count} ${count === 1 ? "phone goes" : "phones go"} back to the store.`)) void run({ action: "cancel" });
        }}
      >
        {busy ? "Cancelling…" : "Cancel pickup"}
      </button>
      <ErrorText error={error} />
    </div>
  );
}
