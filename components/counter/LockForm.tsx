"use client";

import { forwardRef, useState } from "react";
import { Money, Banner, ErrorText } from "@/components/ui";
import { StepCard } from "./StepCard";
import { ID_TYPES } from "./shared";
import type { CaseOps } from "./ops";

const CHECKS = [
  ["ownership", "The customer confirms they own this phone"],
  ["simRemoved", "SIM and memory card removed"],
  ["imeiMatches", "IMEI on the phone (*#06#) matches the one recorded"],
  ["noFinanceLock", "Not on an EMI / finance plan, and no lender or company lock on it"],
] as const;

const KYM_OPTIONS = [
  ["clear", "No block — OK to buy"],
  ["blacklisted", "Black-listed"],
  ["duplicate", "Duplicate IMEI"],
  ["in_use", "Already in use"],
] as const;
type Kym = (typeof KYM_OPTIONS)[number][0];

type CheckKey = (typeof CHECKS)[number][0];

/** ⑦ Take the trade-in: who the customer is, the hand-over checks, and the credit it uses. */
export const LockForm = forwardRef<HTMLInputElement, { ops: CaseOps }>(function LockForm({ ops }, nameRef) {
  const { view, editable, busy, act } = ops;
  const [name, setName] = useState(view.customer?.name ?? "");
  const [phone, setPhone] = useState(view.customer?.phone ?? "");
  const [idType, setIdType] = useState("");
  const [idLast4, setIdLast4] = useState("");
  const [checks, setChecks] = useState<Record<CheckKey, boolean>>({
    ownership: false,
    simRemoved: false,
    imeiMatches: false,
    noFinanceLock: false,
  });
  const [kym, setKym] = useState<Kym | "">("");
  const [kymRef, setKymRef] = useState("");
  const [imeiAck, setImeiAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const digits = phone.replace(/\D/g, "");
  const phoneOk = /^[6-9]\d{9}$/.test(digits);
  const last4Ok = /^[A-Za-z0-9]{4}$/.test(idLast4);
  const anyImeiInvalid = view.imeiCheck === "invalid" || view.imei2Check === "invalid";
  const allChecked = CHECKS.every(([k]) => checks[k]) && (!anyImeiInvalid || imeiAck);
  const kymBlocked = !!kym && kym !== "clear";
  const formOk = name.trim().length >= 2 && phoneOk && !!idType && last4Ok && allChecked && kym === "clear";
  const blockers = view.lockBlockers;
  const cc = view.creditCheck;
  const d = view.decision?.upgrade;
  const canSubmit = editable && view.status === "quoted" && blockers.length === 0 && !busy && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!formOk) {
      setErr(
        name.trim().length < 2
          ? "Enter the customer's name."
          : !phoneOk
            ? "Enter a 10-digit Indian mobile number."
            : !idType
              ? "Choose the customer's ID document."
              : !last4Ok
                ? "Enter the last 4 characters of the ID number."
                : !kym
                  ? "Do the government IMEI check (KYM) and record what it says."
                  : kymBlocked
                    ? "The government register flags this phone — do not take it."
                    : "Tick every hand-over check before taking the phone."
      );
      return;
    }
    setSubmitting(true);
    const e2 = await act("lock", {
      customer: { name: name.trim(), phone: digits, idType, idLast4: idLast4.toUpperCase() },
      checks: { ...checks, kym: { status: kym, reference: kymRef.trim() || null }, imeiCheckAck: anyImeiInvalid ? imeiAck : undefined },
    });
    setSubmitting(false);
    setErr(e2);
  }

  return (
    <StepCard n={7} id="step-lock" title="Take the trade-in">
      <form onSubmit={submit} className="space-y-5">
        <p className="text-[14px] text-ink-2">
          Only when the customer has chosen to upgrade. The store keeps the old phone and its trade-in value is held on the store&apos;s credit line
          until the partner collects it. Next, the customer clears their data from the phone&apos;s Settings — the next screen walks you through it.
        </p>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Customer name</span>
            <input ref={nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} disabled={!editable} />
          </label>
          <label className="block">
            <span className="label">Mobile</span>
            <input
              className="input num"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+]/g, ""))}
              inputMode="tel"
              autoComplete="off"
              placeholder="10 digits"
              maxLength={14}
              disabled={!editable}
              aria-invalid={(digits.length > 0 && !phoneOk) || undefined}
            />
            {digits.length > 0 && !phoneOk ? <span className="hint" style={{ color: "var(--bad)" }}>A 10-digit mobile starting with 6, 7, 8 or 9.</span> : null}
          </label>
          <label className="block">
            <span className="label">ID document seen</span>
            <select className="select" value={idType} onChange={(e) => setIdType(e.target.value)} disabled={!editable}>
              <option value="">Choose…</option>
              {ID_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Last 4 characters of the ID number</span>
            <input
              className="input num uppercase"
              value={idLast4}
              onChange={(e) => setIdLast4(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 4))}
              autoComplete="off"
              maxLength={4}
              placeholder="e.g. 4821"
              disabled={!editable}
            />
            <span className="hint">Only these 4 characters are stored — never the full ID number or a copy of it.</span>
          </label>
        </div>

        <fieldset>
          <legend className="label">Government IMEI check (required)</legend>
          <p className="hint !mt-0 mb-2">
            Since October 2025 anyone buying a used phone must check it against the national IMEI register first. SMS{" "}
            <span className="num font-semibold">KYM {view.imei ?? "<IMEI>"}</span> to <span className="num font-semibold">14422</span>
            {view.imei2 ? (
              <>
                {" "}
                (and again for <span className="num font-semibold">{view.imei2}</span>)
              </>
            ) : null}
            , or use the Sanchar Saathi app, and record the answer.
          </p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Government IMEI check result">
            {KYM_OPTIONS.map(([k, label]) => (
              <button
                type="button"
                key={k}
                className="chip"
                aria-pressed={kym === k}
                onClick={() => setKym(k)}
                disabled={!editable}
                style={k !== "clear" && kym === k ? { background: "var(--bad)", borderColor: "var(--bad)" } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          {kymBlocked ? (
            <div className="mt-2">
              <Banner tone="bad">
                The register flags this phone. Do not take it — hand it back to the customer. Buying a phone reported lost or stolen is an offence.
              </Banner>
            </div>
          ) : null}
          <label className="block mt-3">
            <span className="label">Reference (optional)</span>
            <input className="input" value={kymRef} onChange={(e) => setKymRef(e.target.value)} placeholder="e.g. time of the SMS reply" maxLength={80} disabled={!editable} />
          </label>
        </fieldset>

        <fieldset>
          <legend className="label">Before you take the phone</legend>
          <div className="space-y-2">
            {CHECKS.map(([k, label]) => (
              <label key={k} className="flex items-start gap-3 rounded-[10px] border border-line px-3 py-2.5 cursor-pointer has-[:checked]:border-[color:var(--up)] has-[:checked]:bg-up-bg">
                <input
                  type="checkbox"
                  className="mt-0.5 w-5 h-5 accent-[color:var(--up)]"
                  checked={checks[k]}
                  onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))}
                  disabled={!editable}
                />
                <span className="text-[14.5px]">{label}</span>
              </label>
            ))}
            {anyImeiInvalid ? (
              <label className="flex items-start gap-3 rounded-[10px] border border-[color:var(--warn)] bg-warn-bg px-3 py-2.5 cursor-pointer">
                <input type="checkbox" className="mt-0.5 w-5 h-5" checked={imeiAck} onChange={(e) => setImeiAck(e.target.checked)} disabled={!editable} />
                <span className="text-[14.5px]">
                  The IMEI is correct even though the check digit fails <span className="text-muted">(re-read it from *#06# first)</span>
                </span>
              </label>
            ) : null}
          </div>
        </fieldset>

        {/* Credit */}
        <div>
          <div className="label">Store credit</div>
          {cc ? (
            cc.ok ? (
              <div className="text-[14.5px]">
                <Money value={cc.availableAfter} className="font-bold" /> of credit left after this trade-in.
                {cc.warn ? (
                  <div className="mt-2">
                    <Banner tone="warn">{cc.warn}</Banner>
                  </div>
                ) : null}
              </div>
            ) : (
              <Banner tone="bad">{cc.reason}</Banner>
            )
          ) : (
            <p className="text-[14px] text-muted">Checked once the trade-in is priced.</p>
          )}
        </div>

        {blockers.length ? (
          <Banner tone="warn">
            <div className="font-semibold">Before the trade-in can be taken:</div>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {d && view.upgrade ? (
          <div className="rounded-[12px] bg-up-bg px-4 py-3 text-[14.5px]">
            The customer gets <Money value={d.tradeIn} className="font-bold" /> for the old phone
            {d.bonus ? (
              <>
                {" "}
                plus a <Money value={d.bonus} className="font-bold" /> upgrade bonus
              </>
            ) : null}{" "}
            off the {view.upgrade.model} {view.upgrade.variant}, and pays <Money value={d.pays} className="font-bold" />.
          </div>
        ) : null}

        <button className="btn btn-up w-full sm:w-auto" disabled={!canSubmit}>
          {submitting ? "Taking the trade-in…" : "Take the trade-in"}
        </button>
        <ErrorText error={err} />
      </form>
    </StepCard>
  );
});
