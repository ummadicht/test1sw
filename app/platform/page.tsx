import Link from "next/link";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Stat } from "@/components/ui";
import { BandEditor, OnboardClient, AddPartner } from "@/components/platform/OrgConsole";
import { clientTypeLabel } from "@/components/platform/labels";
import { requirePage } from "@/lib/server/page";
import { listOrgs, type OrgView } from "@/lib/server/admin";
import { orgSettingsDefaults } from "@/lib/server/auth";
import { partnerMode, type PartnerMode } from "@/lib/server/buyback";
import { campaigns } from "@/lib/server/catalog";
import { fmtBp } from "@/lib/domain/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients & partners" };

function ModePill({ mode }: { mode: PartnerMode }) {
  if (mode.kind === "partner_ratecard") return <span className="pill pill-fix">Partner rate card</span>;
  return <span className="pill">No rate card — PriceIQ only</span>;
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="section-title">{label}</dt>
      <dd className="m-0 mt-1 text-[15px] font-semibold break-words">{children}</dd>
    </div>
  );
}

export default async function PlatformPage() {
  const u = await requirePage(["platform"], "/platform");
  const orgs = listOrgs(u);
  const clients = orgs.filter((o) => o.kind === "client");
  const partners = orgs.filter((o) => o.kind === "partner");
  const staff = orgs.filter((o) => o.kind === "platform");
  const modes = new Map<string, PartnerMode>(partners.map((p) => [p.id, partnerMode(p.id)]));
  const totals = {
    stores: clients.reduce((s, c) => s + c.stores, 0),
    people: orgs.reduce((s, o) => s + o.users, 0),
  };
  const defaults = orgSettingsDefaults();

  /** Active campaigns configured outside the client's current band (the band is only checked when a campaign is saved). */
  const outsideBand = (c: OrgView) =>
    campaigns(c.id).filter((cmp) => cmp.active && (cmp.minBp < c.settings.bandMinBp || cmp.maxBp > c.settings.bandMaxBp));

  return (
    <AppShell user={u}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-[26px] font-[750] tracking-tight leading-tight">Clients &amp; partners</h1>
          <p className="hint !mt-1 max-w-2xl">Programmes and their buyback partners.</p>
        </div>
        <Link href="/platform/users" className="btn">
          All users
        </Link>
      </div>

      <div className="card card-pad grid grid-cols-2 sm:grid-cols-4 gap-5 mb-6">
        <Stat label="Clients" value={clients.length} />
        <Stat label="Stores" value={totals.stores} />
        <Stat label="People" value={totals.people} sub="all organisations" />
        <Stat label="Buyback partners" value={partners.length} />
      </div>

      <h2 className="section-title mb-3">Clients</h2>
      {clients.length === 0 ? (
        <div className="card card-pad mb-6 hint">No clients yet — onboard the first one below.</div>
      ) : (
        <div className="grid gap-4 mb-8">
          {clients.map((c) => {
            const mode = c.partnerId ? modes.get(c.partnerId) : undefined;
            const outside = outsideBand(c);
            return (
              <section key={c.id} className="card">
                <div className="card-pad">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[19px] font-[750] tracking-tight leading-snug">{c.name}</h3>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <span className="pill pill-fix">Client</span>
                        {c.demo ? <span className="pill pill-test">◆ Test programme — no real money</span> : <span className="pill pill-up">Live programme</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/admin?orgId=${encodeURIComponent(c.id)}`} className="btn btn-sm btn-primary no-underline">
                        Programme view
                      </Link>
                      <Link href={`/platform/users?orgId=${encodeURIComponent(c.id)}`} className="btn btn-sm no-underline">
                        Users
                      </Link>
                      <Link href={`/admin/stores?orgId=${encodeURIComponent(c.id)}`} className="btn btn-sm no-underline">
                        Stores
                      </Link>
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                    <Meta label="Client type">{clientTypeLabel(c.clientType)}</Meta>
                    <Meta label="Upgrades to">{c.targetBrand ?? "—"}</Meta>
                    <Meta label="Buyback partner">
                      {c.partnerName ?? "—"}
                      {mode ? (
                        <div className="mt-1">
                          <ModePill mode={mode} />
                        </div>
                      ) : null}
                    </Meta>
                    <Meta label="Stores">
                      <span className="num">{c.stores}</span>
                    </Meta>
                    <Meta label="People">
                      <span className="num">{c.users}</span>
                    </Meta>
                  </dl>

                  {c.stores === 0 ? (
                    <div className="banner mt-4">
                      <span aria-hidden>ℹ</span>
                      <div>
                        No stores yet.{" "}
                        <Link href={`/admin/stores?orgId=${encodeURIComponent(c.id)}`} className="font-semibold">
                          Add the first store
                        </Link>
                        , then{" "}
                        <Link href={`/admin/users?orgId=${encodeURIComponent(c.id)}`} className="font-semibold">
                          its people
                        </Link>
                        .
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-5 pt-4 border-t border-line">
                    <div className="section-title mb-2">Upgrade bonus band</div>
                    <BandEditor orgId={c.id} minBp={c.settings.bandMinBp} maxBp={c.settings.bandMaxBp} />
                    <p className="hint">The programme&apos;s promise to customers: every bonus campaign this client runs must stay inside it.</p>
                    {outside.length ? (
                      <div className="banner banner-warn mt-3">
                        <span aria-hidden>⚠</span>
                        <div>
                          {outside.length === 1 ? "A running campaign is" : `${outside.length} running campaigns are`} set outside this band and still pay
                          their own rate until edited:{" "}
                          {outside.map((cmp, i) => (
                            <span key={cmp.id}>
                              {i ? "; " : ""}
                              <strong>{cmp.name}</strong> ({fmtBp(cmp.minBp)}–{fmtBp(cmp.maxBp)})
                            </span>
                          ))}
                          .
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <h2 className="section-title mb-3">Buyback partners</h2>
      {partners.length === 0 ? (
        <div className="card card-pad mb-6 hint">No buyback partners yet — add one below before onboarding a client.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 mb-8">
          {partners.map((p) => {
            const mode = modes.get(p.id)!;
            const served = clients.filter((c) => c.partnerId === p.id);
            return (
              <section key={p.id} className="card">
                <div className="card-pad">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[19px] font-[750] tracking-tight leading-snug">{p.name}</h3>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <span className="pill">Buyback partner</span>
                        <ModePill mode={mode} />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/partner/rate-cards?partnerId=${encodeURIComponent(p.id)}`} className="btn btn-sm btn-primary no-underline">
                        Rate cards
                      </Link>
                      <Link href={`/platform/users?orgId=${encodeURIComponent(p.id)}`} className="btn btn-sm no-underline">
                        Users
                      </Link>
                    </div>
                  </div>
                  <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">{mode.why}</p>
                  <dl className="mt-4 grid grid-cols-2 gap-4">
                    <Meta label="Clients served">
                      {served.length ? served.map((c) => c.name).join(", ") : <span className="text-muted font-normal">None yet</span>}
                    </Meta>
                    <Meta label="People">
                      <span className="num">{p.users}</span>
                    </Meta>
                  </dl>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {staff.map((s) => (
        <p key={s.id} className="hint mb-8">
          {s.name} platform staff: <span className="num">{s.users}</span> {s.users === 1 ? "account" : "accounts"} ·{" "}
          <Link href={`/platform/users?orgId=${encodeURIComponent(s.id)}`}>manage</Link>
        </p>
      ))}

      <h2 className="section-title mb-3">Onboard</h2>
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr] items-start">
        <OnboardClient partners={partners.map((p) => ({ id: p.id, name: p.name }))} defaultBand={{ minBp: defaults.bandMinBp, maxBp: defaults.bandMaxBp }} />
        <AddPartner />
      </div>
    </AppShell>
  );
}
