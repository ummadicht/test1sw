"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { ErrorText, Field } from "@/components/ui";

const MIN = 10;

/** Change your own password: current, new (10+ characters), confirm. */
export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = next.length > 0 && next.length < MIN;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsOld = next.length > 0 && next === current;

  return (
    <form
      className="space-y-4 max-w-md"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setDone(false);
        if (next.length < MIN) return setError(`The new password must be at least ${MIN} characters.`);
        if (next !== confirm) return setError("The two new passwords do not match.");
        if (next === current) return setError("The new password is the same as the current one.");
        setBusy(true);
        try {
          await api("/api/account/password", { body: { current, next } });
          setCurrent("");
          setNext("");
          setConfirm("");
          setDone(true);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Current password">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field
        label="New password"
        hint={`At least ${MIN} characters. A short sentence is easier to remember than symbols.`}
        error={tooShort ? `${MIN - next.length} more character${MIN - next.length === 1 ? "" : "s"} needed.` : sameAsOld ? "That is your current password." : null}
      >
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={MIN} />
      </Field>
      <Field label="New password again" error={mismatch ? "Does not match the new password." : null}>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <button className="btn btn-primary" disabled={busy || tooShort || mismatch || sameAsOld}>
        {busy ? "Saving…" : "Change password"}
      </button>
      {done ? (
        <div className="banner banner-up" role="status">
          <span aria-hidden>✓</span>
          <div>Password changed. Use the new one next time you sign in — you stay signed in on this device.</div>
        </div>
      ) : null}
      <ErrorText error={error} />
    </form>
  );
}
