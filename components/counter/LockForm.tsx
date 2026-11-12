"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { Money, Banner, ErrorText } from "@/components/ui";
import { StepCard } from "./StepCard";
import { ID_TYPES } from "./shared";
import type { CaseOps } from "./ops";
import { HANDOVER_HINT, HANDOVER_LABEL, handoverChecks } from "./handover";
import { RazorpayPaymentPanel } from "./RazorpayPaymentPanel";

const KYM_OPTIONS = [
  ["clear", "No block — OK to buy"],
  ["blacklisted", "Black-listed"],
  ["duplicate", "Duplicate IMEI"],
  ["in_use", "Already in use"],
] as const;
type Kym = (typeof KYM_OPTIONS)[number][0];

/**
 * TAKE THE TRADE-IN — the last step, opened by "Swap up" on the answer: who the customer is, ONE hand-over
 * confirm for the four checks (./handover.ts — the server still gets each flag), and the credit it uses.
 * The IMEI is asked here, first, when the case has none — only taking the phone needs it.
 * The forwarded ref is the first field (the IMEI when it is asked, else the name).
 */
export const LockForm = forwardRef<HTMLInputElement, { ops: CaseOps }>(function LockForm({ ops }, nameRef) {
  const { view, editable, busy, act, save } = ops;
  const [name, setName] = useState(view.customer?.name ?? "");
  const [phone, setPhone] = useState(view.customer?.phone ?? "");
  const [idType, setIdType] = useState("");
  const [idLast4, setIdLast4] = useState("");
  const [handover, setHandover] = useState(false);
  // The KYM answer tapped right after the IMEI (kymEarly) pre-fills — still editable, still "clear" to lock.
  const [kym, setKym] = useState<Kym | "">(view.kymEarly?.status ?? "");
  const [kymRef, setKymRef] = useState(view.kymEarly?.reference ?? "");
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
      setImeiErr("An IMEI has 15 digits.");
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
  const ticked = handover;
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
  const canSubmit = editable && view.status === "quoted" && blockers.length === 0 && !busy && !submitting;
  // The step's one line: the swap being taken, as the store app names it. Every figure is the answer's (each number once).
  const deal = view.upgrade
    ? `${[view.device?.model, view.device?.variant].filter(Boolean).join(" ") || "The customer's phone"} → ${[view.upgrade.model, view.upgrade.variant].filter(Boolean).join(" ") || view.upgrade.label}`
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!formOk) {
      setErr(
        name.trim().length < 2
          ? "Enter the customer's name."
          : !phoneOk
            ? "Enter a 10-digit mobile."
            : !idType
              ? "Choose the ID."
              : !last4Ok
                ? "Enter the ID's last 4."
                : !kym
                  ? "Do the IMEI register check (KYM)."
                  : kymBlocked
                    ? "Register flags it — do not take it."
                    : !ticked
                      ? "Tick the hand-over check."
                      : !storageOk
                        ? `Confirm Settings shows ${variant ?? "the storage"}.`
                        : "Re-read the IMEI, or confirm it."
      );
      return;
    }
    setSubmitting(true);
    const e2 = await act("lock", {
      customer: { name: name.trim(), phone: digits, idType, idLast4: idLast4.toUpperCase() },
      checks: {
        // One tick on the form, the four flags the server checks one by one.
        ...handoverChecks(handover),
        kym: { status: kym, reference: kymRef.trim() || null },
        imeiCheckAck: anyImeiInvalid ? imeiAck : undefined,
        storageSeen: storageClaimed ? storageSeen : undefined,
      },
    });
    setSubmitting(false);
    setErr(e2);
  }

  return (
    <StepCard
      id="step-lock"
      title="Take the trade-in"
      line={deal}
      details={
        <p className="text-[14px] text-ink-2">Held on the store&apos;s credit line until the partner collects. Data clear comes next.</p>
      }
    >
      <form onSubmit={submit} className="space-y-5">

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
                {view.imeiCheck === "invalid" ? <span className="pill pill-warn">⚠ Re-read the IMEI</span> : null}
              </div>
            </label>
            {imeiErr ? (
              <span className="hint" style={{ color: "var(--bad)" }}>
                {imeiErr}
              </span>
            ) : (
              <span className="hint">Dial *#06#, or scan the box.</span>
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
            {digits.length > 0 && !phoneOk ? <span className="hint" style={{ color: "var(--bad)" }}>10 digits, starting 6–9.</span> : null}
          </label>
          <label className="block">
            <span className="label">ID seen</span>
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
            <span className="label">ID last 4</span>
            <input
              className="input num uppercase"
              value={idLast4}
              onChange={(e) => setIdLast4(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 4))}
              autoComplete="off"
              maxLength={4}
              placeholder="e.g. 4821"
              disabled={!editable}
            />
            <span className="hint">Only these 4 are stored.</span>
          </label>
        </div>

        <fieldset>
          <legend className="label">IMEI register check</legend>
          <p className="hint !mt-0 mb-2">
            SMS <span className="num font-semibold">KYM {view.imei ?? "<IMEI>"}</span> to <span className="num font-semibold">14422</span>
            {view.imei2 ? (
              <>
                {" "}
                (again for <span className="num font-semibold">{view.imei2}</span>)
              </>
            ) : null}
            , or use Sanchar Saathi.
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
              <Banner tone="bad">Flagged — do not take it. Hand it back.</Banner>
            </div>
          ) : null}
          <label className="block mt-3">
            <span className="label">Reference (optional)</span>
            <input className="input" value={kymRef} onChange={(e) => setKymRef(e.target.value)} placeholder="e.g. SMS time" maxLength={80} disabled={!editable} />
          </label>
        </fieldset>

        <fieldset>
          <legend className="label">Hand-over</legend>
          <div className="space-y-2">
            <label className="flex items-start gap-3 rounded-[10px] border border-line px-3 py-2.5 cursor-pointer has-[:checked]:border-[color:var(--up)] has-[:checked]:bg-up-bg">
              <input
                type="checkbox"
                className="mt-0.5 w-5 h-5 accent-[color:var(--up)]"
                checked={handover}
                onChange={(e) => setHandover(e.target.checked)}
                disabled={!editable}
              />
              <span className="text-[14.5px]">
                <span className="font-semibold">{HANDOVER_LABEL}</span>
                <span className="block text-muted text-[13.5px] mt-0.5">{HANDOVER_HINT}</span>
              </span>
            </label>
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
                  Settings shows {variant}
                </span>
              </label>
            ) : null}
            {anyImeiInvalid ? (
              <label className="flex items-start gap-3 rounded-[10px] border border-[color:var(--warn)] bg-warn-bg px-3 py-2.5 cursor-pointer">
                <input type="checkbox" className="mt-0.5 w-5 h-5" checked={imeiAck} onChange={(e) => setImeiAck(e.target.checked)} disabled={!editable} />
                <span className="text-[14.5px]">
                  IMEI is correct <span className="text-muted">(re-read *#06#)</span>
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
                <Money value={cc.availableAfter} className="font-bold" /> credit left after this.
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
            <p className="text-[14px] text-muted">Checked once priced.</p>
          )}
        </div>

        {blockers.length ? (
          <Banner tone="warn">
            <div className="font-semibold">Before taking it:</div>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {view.offer?.swap.customerPays && view.offer.swap.customerPays > 0 ? (
          <RazorpayPaymentPanel
            caseId={view.id}
            caseRef={view.ref}
            mode="swap"
            repairAmount={view.offer?.repair.amount ?? null}
            swapAmount={view.offer.swap.customerPays}
            customerName={name || view.customer?.name}
            customerPhone={digits || view.customer?.phone}
          />
        ) : null}

        <button className="btn btn-up w-full sm:w-auto" disabled={!canSubmit}>
          {submitting ? "Taking…" : "Take the trade-in"}
        </button>
        <ErrorText error={err} />
      </form>
    </StepCard>
  );
});
