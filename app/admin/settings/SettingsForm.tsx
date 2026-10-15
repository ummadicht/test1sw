"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Banner, Card, ErrorText, Field } from "@/components/ui";
import { fmtBp, inr } from "@/lib/domain/money";
import type { OrgSettings } from "@/lib/server/auth";
import { buildSettingsPatch, toForm, type SettingsFormValues as Form } from "@/components/admin/settingsModel";

export function SettingsForm({
  orgId,
  isPlatform,
  initial,
  labourDefaults,
}: {
  orgId: string;
  isPlatform: boolean;
  initial: OrgSettings;
  labourDefaults: Record<string, number>;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [f, setF] = useState<Form>(() => toForm(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { patch, errors } = useMemo(() => buildSettingsPatch(f, isPlatform), [f, isPlatform]);
  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(saved));
  const errCount = Object.keys(errors).length;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setNotice(null);
    setF((p) => ({ ...p, [k]: e.target.value }));
  };
  const input = (k: keyof Form, mode: "numeric" | "decimal" = "numeric", extra = "") => (
    <input className={`input num ${extra}`} inputMode={mode} value={f[k]} onChange={set(k)} aria-invalid={!!errors[k]} />
  );

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (errCount) return setError("Fix the highlighted fields first.");
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const r = await api<{ settings: OrgSettings }>("/api/admin/settings", { body: { orgId: isPlatform ? orgId : undefined, patch } });
          setSaved(r.settings);
          setF(toForm(r.settings));
          setNotice("Settings saved. They apply to the next case, quote and credit check.");
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card title="Store credit line">
        <div className="space-y-6">
          <fieldset>
            <legend className="label">When does a trade-in stop counting against the store&apos;s line?</legend>
            <div className="grid md:grid-cols-2 gap-3">
              <Choice
                name="releaseOn"
                checked={f.releaseOn === "collected"}
                onChange={() => setF((p) => ({ ...p, releaseOn: "collected" }))}
                title="When the partner collects it"
              >
                The line frees up as soon as the courier takes the phones, so stores keep trading in. If the partner later pays less, the difference comes back
                as a chargeback.
              </Choice>
              <Choice
                name="releaseOn"
                checked={f.releaseOn === "cleared"}
                onChange={() => setF((p) => ({ ...p, releaseOn: "cleared" }))}
                title="When the partner clears it"
              >
                The line frees up only after the partner has checked each phone and confirmed its value. Fewer surprises, but stores wait longer before they
                can trade in again.
              </Choice>
            </div>
          </fieldset>

          <div>
            <div className="label">Ask the store to book a pickup when any of these is reached</div>
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Line used (%)" error={errors.warnAtPct} hint="e.g. 80 — the meter turns amber here.">
                {input("warnAtPct", "decimal")}
              </Field>
              <Field label="A phone has waited (days)" error={errors.maxAgeDays} hint="Older phones lose resale value.">
                {input("maxAgeDays")}
              </Field>
              <Field label="Phones waiting" error={errors.pickupAtCount} hint="Whatever their value.">
                {input("pickupAtCount")}
              </Field>
            </div>
          </div>

          <fieldset>
            <legend className="label">Who carries the shortfall when the partner pays less after inspection (a regrade) or rejects a phone?</legend>
            <div className="grid md:grid-cols-2 gap-3">
              <Choice
                name="shortfall"
                checked={f.shortfallLiability === "store"}
                onChange={() => setF((p) => ({ ...p, shortfallLiability: "store" }))}
                title="The store"
              >
                The difference goes back on the store&apos;s credit line as a chargeback until it is recovered.
              </Choice>
              <Choice
                name="shortfall"
                checked={f.shortfallLiability === "partner"}
                onChange={() => setF((p) => ({ ...p, shortfallLiability: "partner" }))}
                title="The partner"
              >
                The partner absorbs the difference; the store&apos;s line is not charged.
              </Choice>
            </div>
            <p className="hint">A phone the partner says never arrived is always charged to the store until the dispute is settled.</p>
          </fieldset>
        </div>
      </Card>

      <Card title="Repair quotes">
        <div className="space-y-4">
          <div>
            <div className="label">Labour per repair job, by service tier (₹)</div>
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Galaxy Z" error={errors.labourZ}>
                {input("labourZ")}
              </Field>
              <Field label="Galaxy S" error={errors.labourS}>
                {input("labourS")}
              </Field>
              <Field label="Other models" error={errors.labourOther}>
                {input("labourOther")}
              </Field>
            </div>
            <p className="hint">
              The defaults ({inr(labourDefaults.Z ?? null)} / {inr(labourDefaults.S ?? null)} / {inr(labourDefaults.other ?? null)}) are Samsung India&apos;s published
              L2 labour charges. Charged once per job, before GST.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="GST on parts + labour (%)" error={errors.gstPct} hint="Part list prices exclude it.">
              {input("gstPct", "decimal")}
            </Field>
            <Field label="Default Care+ claim fee (₹)" error={errors.carePlus} hint="Used when a model has no fee of its own recorded.">
              {input("carePlus")}
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Trade-in quotes">
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Quote valid for (days)" error={errors.quoteValidity} hint="Leave blank to use the partner's rate-card validity.">
            <input className="input num" inputMode="numeric" value={f.quoteValidity} onChange={set("quoteValidity")} placeholder="partner's" aria-invalid={!!errors.quoteValidity} />
          </Field>
        </div>
      </Card>

      <Card title="Repair-or-upgrade recommendation">
        <p className="hint !mt-0 mb-4">
          Repair share = the repair cost ÷ what the phone is worth once repaired. These thresholds decide which way each money signal points.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Point to upgrade at a repair share of (%)" error={errors.upgradeRatioPct} hint="At or above this, the repair is poor value.">
            {input("upgradeRatioPct", "decimal")}
          </Field>
          <Field label="Point to repair at a repair share of (%)" error={errors.repairRatioPct} hint="At or below this, the repair is clearly worth it.">
            {input("repairRatioPct", "decimal")}
          </Field>
          <Field label="Ignore money gaps under (₹)" error={errors.materialGap} hint="Smaller differences are noise, not a reason.">
            {input("materialGap")}
          </Field>
          <Field label="Mention updates ending within (years)" error={errors.supportSoonYears}>
            {input("supportSoonYears", "decimal")}
          </Field>
          <Field label="Mention a phone this old (years)" error={errors.oldAgeYears}>
            {input("oldAgeYears", "decimal")}
          </Field>
        </div>
      </Card>

      <Card title="Upgrade bonus band">
        {isPlatform ? (
          <div className="space-y-3">
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Minimum (%)" error={errors.bandMinPct}>
                {input("bandMinPct", "decimal")}
              </Field>
              <Field label="Maximum (%)" error={errors.bandMaxPct}>
                {input("bandMaxPct", "decimal")}
              </Field>
            </div>
            <p className="hint">Every campaign this client runs must sit inside this band. Existing campaigns outside a new band will be refused when next saved.</p>
          </div>
        ) : (
          <p className="text-ink-2">
            <strong className="num text-ink text-[18px]">
              {fmtBp(saved.bandMinBp)}–{fmtBp(saved.bandMaxBp)}
            </strong>{" "}
            · set by SwapUp. Every upgrade-bonus campaign must stay inside it. Ask SwapUp if your programme needs a different band.
          </p>
        )}
      </Card>

      <div className="sticky bottom-0 z-10 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-[color:var(--canvas)]/95 backdrop-blur border-t border-line sm:border-0">
        {notice ? (
          <div className="mb-3">
            <Banner tone="up">{notice}</Banner>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy || !dirty} onClick={() => setF(toForm(saved))}>
            Discard changes
          </button>
          {errCount ? (
            <span className="text-[13.5px] text-bad font-semibold">
              {errCount} field{errCount === 1 ? "" : "s"} need{errCount === 1 ? "s" : ""} fixing
            </span>
          ) : dirty ? (
            <span className="text-[13.5px] text-ink-2">Unsaved changes</span>
          ) : null}
        </div>
        <ErrorText error={error} />
      </div>
    </form>
  );
}

function Choice({ name, checked, onChange, title, children }: { name: string; checked: boolean; onChange: () => void; title: string; children: ReactNode }) {
  return (
    <label
      className={`flex gap-3 items-start rounded-[12px] border p-4 cursor-pointer ${
        checked ? "border-[color:var(--ink)] bg-[color:var(--surface-2)]" : "border-line hover:bg-[color:var(--surface-2)]"
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 w-4 h-4 accent-[color:var(--ink)]" />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-[13.5px] text-ink-2 mt-0.5 leading-snug">{children}</span>
      </span>
    </label>
  );
}
