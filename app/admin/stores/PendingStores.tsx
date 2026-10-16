"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Card, ErrorText, fmtDate } from "@/components/ui";

export type PendingStore = {
  id: string;
  name: string;
  city: string | null;
  kind: string;
  code: string;
  managerName: string | null;
  managerUsername: string | null;
  contactPhone: string | null;
  createdAt: string;
};

const KIND: Record<string, string> = { service_center: "Service centre", experience_center: "Experience centre", retail: "Retail store" };

/** Stores that registered themselves from the app. Approving sets the credit line that lets them take trade-ins. */
export function PendingStores({ stores }: { stores: PendingStore[] }) {
  if (!stores.length) return null;
  return (
    <Card title={`Waiting for approval · ${stores.length}`} className="mb-5 border-[color:var(--warn)]">
      <p className="hint !mt-0 mb-3 text-[14px]">
        These stores signed up from the SwapUp Store app. They can already test customers&apos; phones and see quotes; they can&apos;t take a trade-in until you
        approve them and set a credit limit. Check the manager by phone before approving.
      </p>
      <div className="space-y-3">
        {stores.map((s) => (
          <Row key={s.id} s={s} />
        ))}
      </div>
    </Card>
  );
}

function Row({ s }: { s: PendingStore }) {
  const router = useRouter();
  const [limit, setLimit] = useState("100000");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"idle" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(decision: "approve" | "reject") {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/admin/stores/${s.id}/review`, {
        body: decision === "approve" ? { decision, creditLimit: Number(limit.replace(/[^\d]/g, "")) } : { decision, note },
      });
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[12px] border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[15.5px]">
            {s.name} <span className="pill ml-1">{s.code}</span>
          </div>
          <div className="text-[13.5px] text-ink-2">
            {KIND[s.kind] ?? s.kind}
            {s.city ? ` · ${s.city}` : ""} · registered {fmtDate(s.createdAt)}
          </div>
          <div className="text-[13.5px] text-ink-2">
            Manager: {s.managerName ?? "—"} ({s.managerUsername ?? "—"}){s.contactPhone ? ` · ${s.contactPhone}` : ""}
          </div>
        </div>
        {mode === "idle" ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="label !mb-1">Credit limit (₹)</span>
              <input className="input num !min-h-[40px] w-[150px]" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </label>
            <button className="btn btn-up" disabled={busy} onClick={() => send("approve")}>
              Approve
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setMode("reject")}>
              Reject
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2 w-full sm:w-auto">
            <label className="block flex-1">
              <span className="label !mb-1">Why (the manager sees this)</span>
              <input className="input !min-h-[40px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Not an authorised service centre" />
            </label>
            <button className="btn btn-danger" disabled={busy} onClick={() => send("reject")}>
              Reject store
            </button>
            <button className="btn btn-ghost" onClick={() => setMode("idle")}>
              Back
            </button>
          </div>
        )}
      </div>
      <ErrorText error={err} />
    </div>
  );
}
