"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { Card, ErrorText } from "@/components/ui";

/** GET/PUT /api/stores/<id>/phonecheck (lib/server/phonecheck.ts stationView). */
export type StationState = { station: string | null; serverDefault: boolean; configured: { ok: boolean; why: string } };

/**
 * The store's Phonecheck station login (docs/GRADING.md). A pull asks Phonecheck
 * for this IMEI's newest check AS this station — Phonecheck refuses the master
 * account name. Phonecheck ships switched off: until the server has its key the
 * card says so, and the login can still be set ready for the day it's on.
 * Store manager of the store or the programme admin; the partner never sees it.
 */
export function StorePhonecheck({ storeId, initial, canEdit }: { storeId: string; initial: StationState; canEdit: boolean }) {
  const [state, setState] = useState(initial);
  const [value, setValue] = useState(initial.station ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = value.trim() !== (state.station ?? "");

  const save = async (station: string | null) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api<StationState>(`/api/stores/${encodeURIComponent(storeId)}/phonecheck`, { method: "PUT", body: { station } });
      setState(next);
      setValue(next.station ?? "");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Phonecheck station">
      <p className={`text-[14px] ${state.configured.ok ? "text-ink-2" : "text-warn"}`}>
        {state.configured.ok ? "Phonecheck is on." : state.configured.why}
      </p>
      {canEdit ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(value.trim() || null);
          }}
        >
          <label className="block min-w-0 flex-1 basis-[220px]">
            <span className="label">Station login</span>
            <input
              className="input"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. Teja-D04"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          {state.station ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(null)}>
              Clear
            </button>
          ) : null}
        </form>
      ) : (
        <p className="text-[14px] mt-2">
          Station login: <strong>{state.station ?? "not set"}</strong>
        </p>
      )}
      {saved ? <p className="text-[13px] text-up mt-2">Saved.</p> : null}
      <ErrorText error={error} />
      <p className="hint">{!state.station && state.serverDefault ? "Not set — uses the server's default." : "The station's own login, not the master account."}</p>
    </Card>
  );
}
