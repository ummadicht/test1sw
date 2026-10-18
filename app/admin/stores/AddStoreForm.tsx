"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Field } from "@/components/ui";
import { STORE_KINDS, STORE_KIND_LABEL, parseRupees } from "@/components/admin/format";

type Created = { store: { id: string; name: string; code: string; credit_limit: number } };

const EMPTY = { name: "", kind: "service_center", city: "", code: "", limit: "" };

/** Add a store to the programme. The code prefixes every case number at that store. */
export function AddStoreForm({ orgId, isPlatform, usersHref }: { orgId: string; isPlatform: boolean; usersHref: string | null }) {
  const router = useRouter();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Created["store"] | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const code = f.code.trim().toUpperCase();
  const codeOk = /^[A-Z0-9]{2,8}$/.test(code);
  const limit = parseRupees(f.limit);
  const limitOk = limit !== null && limit >= 0;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (!codeOk) return setError("Store code: 2–8 letters or digits.");
        if (!limitOk) return setError("Credit limit must be a whole rupee amount.");
        setBusy(true);
        try {
          const r = await api<Created>("/api/admin/stores", {
            body: { orgId: isPlatform ? orgId : undefined, name: f.name.trim(), kind: f.kind, city: f.city.trim(), code, creditLimit: limit },
          });
          setAdded(r.store);
          setF(EMPTY);
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Store name">
          <input className="input" value={f.name} onChange={set("name")} placeholder="e.g. Indiranagar Experience Center" required minLength={3} maxLength={80} />
        </Field>
        <Field label="Type">
          <select className="select" value={f.kind} onChange={set("kind")}>
            {STORE_KINDS.map((k) => (
              <option key={k} value={k}>
                {STORE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={set("city")} placeholder="e.g. Bengaluru" maxLength={60} />
        </Field>
        <Field
          label="Store code"
          hint={codeOk ? `Case numbers will read SU-${code}-00001` : "2–8 letters or digits. It starts every case number at this store."}
          error={f.code && !codeOk ? "2–8 letters or digits only." : null}
        >
          <input
            className="input num"
            value={f.code}
            onChange={(e) => setF((p) => ({ ...p, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))}
            maxLength={8}
            placeholder="e.g. IND"
            required
          />
        </Field>
        <Field label="Trade-in credit limit (₹)" hint="Max trade-in value held before pickup." error={f.limit && !limitOk ? "Whole rupees only." : null}>
          <input className="input num" inputMode="numeric" value={f.limit} onChange={set("limit")} placeholder="e.g. 200000" required />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || f.name.trim().length < 3 || !codeOk || !limitOk}>
          {busy ? "Adding…" : "Add store"}
        </button>
      </div>
      <ErrorText error={error} />
      {added ? (
        <Banner tone="up">
          <strong>{added.name}</strong> added with code {added.code}.{" "}
          {usersHref ? (
            <>
              Next, give its manager and advisors a login on <a href={usersHref}>Users</a>.
            </>
          ) : (
            "Next, give its manager and advisors a login."
          )}
        </Banner>
      ) : null}
    </form>
  );
}
