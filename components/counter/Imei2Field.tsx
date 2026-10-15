"use client";

import { useEffect, useRef, useState } from "react";
import type { CaseOps } from "./ops";

/**
 * The second IMEI of a dual-SIM phone. Optional, but recorded when the phone
 * has one: the one-phone-one-trade-in check matches on either number, so the
 * same phone cannot come back under its other IMEI.
 */
export function Imei2Field({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [val, setVal] = useState(view.imei2 ?? "");
  const [err, setErr] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => setVal(view.imei2 ?? ""), [view.imei2]);

  async function commit() {
    const d = val.replace(/\D/g, "");
    if (d === (view.imei2 ?? "") || d === last.current) return;
    last.current = d;
    if (!d) {
      setErr(await save({ imei2: null }, { imei2: null, imei2Check: null }));
      return;
    }
    if (d.length !== 14 && d.length !== 15) {
      setErr(`An IMEI has 15 digits — this has ${d.length}.`);
      return;
    }
    setErr(await save({ imei2: d }));
  }

  return (
    <div>
      <label className="block">
        <span className="label">
          IMEI 2 <span className="text-muted font-normal">(dual-SIM phones)</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input num max-w-[260px]"
            value={val}
            onChange={(e) => {
              setVal(e.target.value.replace(/[^\d\s]/g, ""));
              setErr(null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Second IMEI, if shown"
            maxLength={18}
            disabled={!editable}
            aria-invalid={!!err || view.imei2Check === "invalid" || undefined}
          />
          {view.imei2 && view.imei2Check === "valid" && val.replace(/\D/g, "") === view.imei2 ? <span className="pill pill-up">✓ Check digit OK</span> : null}
          {view.imei2Check === "invalid" ? <span className="pill pill-warn">⚠ Check digit fails — re-read it</span> : null}
        </div>
      </label>
      {err ? (
        <span className="hint" style={{ color: "var(--bad)" }}>
          {err}
        </span>
      ) : (
        <span className="hint">*#06# shows both on a dual-SIM phone. Both are checked against other trade-ins.</span>
      )}
    </div>
  );
}
