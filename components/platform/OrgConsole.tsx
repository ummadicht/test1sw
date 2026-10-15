"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Card, ErrorText, Field } from "@/components/ui";
import { fmtBp, pctToBp, bpToPct } from "@/lib/domain/money";
import type { OrgView } from "@/lib/server/admin";
import { CLIENT_TYPES, CLIENT_TYPE_LABEL, type ClientType } from "./labels";

/* ── bonus band: the programme's 2–5% promise ─────────────── */

export function BandEditor({ orgId, minBp, maxBp }: { orgId: string; minBp: number; maxBp: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [lo, setLo] = useState(String(bpToPct(minBp)));
  const [hi, setHi] = useState(String(bpToPct(maxBp)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="num text-[20px] font-bold">
          {fmtBp(minBp)} – {fmtBp(maxBp)}
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            setLo(String(bpToPct(minBp)));
            setHi(String(bpToPct(maxBp)));
            setError(null);
            setEditing(true);
          }}
        >
          Change band
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const a = Number(lo);
        const b = Number(hi);
        if (!Number.isFinite(a) || !Number.isFinite(b) || lo.trim() === "" || hi.trim() === "") return setError("Enter both percentages.");
        if (a < 0 || b > 10) return setError("The band must sit within 0–10%.");
        if (a > b) return setError("The minimum is above the maximum.");
        setBusy(true);
        try {
          await api(`/api/orgs/${encodeURIComponent(orgId)}/settings`, { body: { bandMinBp: pctToBp(a), bandMaxBp: pctToBp(b) } });
          setEditing(false);
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Minimum %</span>
          <input className="input num !w-[110px]" type="number" inputMode="decimal" step="0.25" min="0" max="10" value={lo} onChange={(e) => setLo(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Maximum %</span>
          <input className="input num !w-[110px]" type="number" inputMode="decimal" step="0.25" min="0" max="10" value={hi} onChange={(e) => setHi(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save band"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      <p className="hint">
        Checked whenever this client saves a bonus campaign. Campaigns already running keep their own minimum and maximum until they are edited.
      </p>
      <ErrorText error={error} />
    </form>
  );
}

/* ── onboarding ──────────────────────────────────────────── */

type PartnerOption = { id: string; name: string };

export function OnboardClient({ partners, defaultBand }: { partners: PartnerOption[]; defaultBand: { minBp: number; maxBp: number } }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState<ClientType>("oem_service");
  const [targetBrand, setTargetBrand] = useState("Samsung");
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OrgView | null>(null);

  return (
    <Card title="Onboard a client">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const r = await api<{ org: OrgView }>("/api/orgs", { body: { kind: "client", name: name.trim(), clientType, targetBrand: targetBrand.trim(), partnerId } });
            setCreated(r.org);
            setName("");
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Client name" hint="As it should appear to their staff, e.g. the brand's service network or the retail chain.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={120} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind of client">
            <select className="select" value={clientType} onChange={(e) => setClientType(e.target.value as ClientType)}>
              {CLIENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CLIENT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Brand customers upgrade to">
            <input className="input" value={targetBrand} onChange={(e) => setTargetBrand(e.target.value)} maxLength={40} />
          </Field>
        </div>
        <Field label="Buyback partner" hint="Prices the trade-ins and collects the phones from this client's stores.">
          {partners.length === 0 ? (
            <div className="input flex items-center text-muted">Add a buyback partner first</div>
          ) : (
            <select className="select" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="hint">
          A new client starts with no stores, no people, and the default programme settings (upgrade bonus band {fmtBp(defaultBand.minBp)}–
          {fmtBp(defaultBand.maxBp)}). It is a real programme, not a demo: its stores cannot lock a trade-in priced from a SAMPLE rate card.
        </p>
        <button className="btn btn-primary" disabled={busy || partners.length === 0}>
          {busy ? "Creating…" : "Create client"}
        </button>
        <ErrorText error={error} />
        {created ? (
          <div className="banner banner-up" role="status">
            <span aria-hidden>✓</span>
            <div>
              <strong>{created.name}</strong> is set up. Next, give it stores and people:{" "}
              <Link href={`/admin/stores?orgId=${encodeURIComponent(created.id)}`} className="font-semibold">
                add stores
              </Link>
              , then{" "}
              <Link href={`/admin/users?orgId=${encodeURIComponent(created.id)}`} className="font-semibold">
                add its programme admin and counter staff
              </Link>
              .
            </div>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

export function AddPartner() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OrgView | null>(null);

  return (
    <Card title="Add a buyback partner">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const r = await api<{ org: OrgView }>("/api/orgs", { body: { kind: "partner", name: name.trim() } });
            setCreated(r.org);
            setName("");
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Partner name" hint="The company that prices trade-ins, collects phones from stores and settles.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={120} />
        </Field>
        <p className="hint">
          A new partner has no rate card, so it cannot price a trade-in until its team uploads one (or its live API is connected). Its first upload
          must include its condition deductions.
        </p>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add partner"}
        </button>
        <ErrorText error={error} />
        {created ? (
          <div className="banner banner-up" role="status">
            <span aria-hidden>✓</span>
            <div>
              <strong>{created.name}</strong> added.{" "}
              <Link href={`/platform/users?orgId=${encodeURIComponent(created.id)}`} className="font-semibold">
                Add its operations team
              </Link>{" "}
              or{" "}
              <Link href={`/partner/rate-cards?partnerId=${encodeURIComponent(created.id)}`} className="font-semibold">
                load its rate card
              </Link>
              .
            </div>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
