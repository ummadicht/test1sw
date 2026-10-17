"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
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

/**
 * ⑦ Take the trade-in: who the customer is, the hand-over checks, and the credit it uses.
 * The IMEI is asked here, first, when the case has none — only taking the phone needs it.
 * The forwarded ref is the first field (the IMEI when it is asked, else the name).
 */
export const LockForm = forwardRef<HTMLInputElement, { ops: CaseOps }>(function LockForm({ ops }, nameRef) {
  const { view, editable, busy, act, save } = ops;
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
  // The storage tick confirms ONE size: if the storage changes, it is unticked.
  const [storageSeenFor, setStorageSeenFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // IMEI — asked here while the case has none; kept on screen once typed here, so a typo can be fixed.
  const [imeiTypedHere, setImeiTypedHere] = useState(false);
  const [imei, setImei] = useState(view.imei ?? "");
  const [imeiErr, setImeiErr] = useState<string | null>(null);
  const askImei = !view.imei || imeiTypedHere;
  const savedImei = view.imei ?? "";
  const lastSaved = useRef(savedImei);
  const imeiSent = useRef<string | null>(null);
  useEffect(() => {
    // Keep the field in step with the server's reading (it completes a 14-digit IMEI).
    if (savedImei !== lastSaved.current) {
      lastSaved.current = savedImei;
      setImei(savedImei);
    }
  }, [savedImei]);

  async function saveImei() {
    const d = imei.replace(/\D/g, "");
    if (d === (view.imei ?? "") || d === imeiSent.current) return;
    if (!d) {
      setImeiErr(await save({ imei: null }, { imei: null, imeiCheck: null }));
      return;
    }
    if (d.length !== 14 && d.length !== 15) {
      setImeiErr(`An IMEI has 15 digits — this has ${d.length}.`);
      return;
    }
    imeiSent.current = d;
    const e = await save({ imei: d });
    imeiSent.current = null;
    setImeiErr(e);
  }

  const digits = phone.replace(/\D/g, "");
  const phoneOk = /^[6-9]\d{9}$/.test(digits);
  const last4Ok = /^[A-Za-z0-9]{4}$/.test(idLast4);
  const anyImeiInvalid = view.imeiCheck === "invalid" || view.imei2Check === "invalid";
  const ticked = CHECKS.every(([k]) => checks[k]);
  // A storage the customer typed (the phone couldn't measure it) is enough to show a price; taking the phone needs it seen.
  const variant = view.device?.variant ?? null;
  const storageClaimed = view.variantSource === "customer";
  const storageSeen = storageClaimed && !!variant && storageSeenFor === variant;
  const storageOk = !storageClaimed || storageSeen;
  const imeiAckOk = !anyImeiInvalid || imeiAck;
  const kymBlocked = !!kym && kym !== "clear";
  const formOk = name.trim().length >= 2 && phoneOk && !!idType && last4Ok && kym === "clear" && ticked && storageOk && imeiAckOk;
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
                    : !ticked
                      ? "Tick every hand-over check before taking the phone."
                      : !storageOk
                        ? `Confirm before taking the phone: Settings › About phone shows ${variant ?? "the storage"} (the customer typed it — the phone couldn't measure it).`
                        : "An IMEI fails its check digit. Re-read it from *#06#, or confirm it is correct."
      );
      return;
    }
    setSubmitting(true);
    const e2 = await act("lock", {
      customer: { name: name.trim(), phone: digits, idType, idLast4: idLast4.toUpperCase() },
      checks: {
        ...checks,
        kym: { status: kym, reference: kymRef.trim() || null },
        imeiCheckAck: anyImeiInvalid ? imeiAck : undefined,
        storageSeen: storageClaimed ? storageSeen : undefined,
      },
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

        {askImei ? (
          <div>
            <label className="block">
              <span className="label">IMEI</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={askImei ? nameRef : undefined}
                  className="input num max-w-[260px]"
                  value={imei}
                  onChange={(e) => {
                    setImei(e.target.value.replace(/[^\d\s]/g, ""));
                    setImeiTypedHere(true);
                    setImeiErr(null);
                  }}
                  onBlur={saveImei}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveImei();
                    }
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="15 digits"
                  maxLength={18}
                  disabled={!editable}
                  aria-invalid={!!imeiErr || view.imeiCheck === "invalid" || undefined}
                />
                {view.imei && view.imeiCheck === "valid" && imei.replace(/\D/g, "") === view.imei ? <span className="pill pill-up">✓ Check digit OK</span> : null}
                {view.imeiCheck === "invalid" ? <span className="pill pill-warn">⚠ Check digit fails — re-read it</span> : null}
              </div>
            </label>
            {imeiErr ? (
              <span className="hint" style={{ color: "var(--bad)" }}>
                {imeiErr}
              </span>
            ) : (
              <span className="hint">Dial *#06# on the phone, or scan the barcode on the box. 14 digits are completed automatically.</span>
            )}
          </div>
        ) : null}

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Customer name</span>
            <input ref={askImei ? undefined : nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} disabled={!editable} />
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
            {storageClaimed && variant ? (
              <label className="flex items-start gap-3 rounded-[10px] border border-line px-3 py-2.5 cursor-pointer has-[:checked]:border-[color:var(--up)] has-[:checked]:bg-up-bg">
                <input
                  type="checkbox"
                  className="mt-0.5 w-5 h-5 accent-[color:var(--up)]"
                  checked={storageSeen}
                  onChange={(e) => setStorageSeenFor(e.target.checked ? variant : null)}
                  disabled={!editable}
                />
                <span className="text-[14.5px]">
                  Settings › About phone shows {variant} <span className="text-muted">(the customer typed it — the phone couldn&apos;t measure it)</span>
                </span>
              </label>
            ) : null}
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
