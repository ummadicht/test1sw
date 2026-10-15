"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Money } from "@/components/ui";
import { fmtBp } from "@/lib/domain/money";
import { fmtDay } from "@/components/admin/format";
import {
  basisLabel,
  bandText,
  campaignStatus,
  describeCondition,
  emptyDraft,
  fromDraft,
  toDraft,
  type CampaignWithActive,
  type Draft,
} from "@/components/admin/campaignDraft";
import { CampaignEditor } from "./CampaignEditor";
import { BonusTryIt, type PhoneOption } from "./BonusTryIt";

export function CampaignsConsole({
  orgId,
  isPlatform,
  initial,
  band,
  brands,
  phones,
  defaultStoreKind,
  today,
}: {
  orgId: string;
  isPlatform: boolean;
  initial: CampaignWithActive[];
  band: { minBp: number; maxBp: number };
  brands: string[];
  phones: PhoneOption[];
  defaultStoreKind: string;
  today: string;
}) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const built = useMemo(() => (draft ? fromDraft(draft, band) : null), [draft, band]);
  const liveCount = list.filter((c) => campaignStatus(c, today).live).length;

  async function save(campaign: CampaignWithActive | ReturnType<typeof fromDraft>["campaign"], active: boolean, key: string, done: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ campaigns: CampaignWithActive[] }>("/api/admin/campaigns", {
        body: { orgId: isPlatform ? orgId : undefined, campaign, active },
      });
      setList(r.campaigns);
      setDraft(null);
      setNotice(done);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const notLive = (() => {
    if (!draft || !built) return null;
    const s = campaignStatus({ ...built.campaign, active: draft.active }, today);
    return s.live ? null : s.label;
  })();

  return (
    <div className="space-y-5">
      {notice ? <Banner tone="up">{notice}</Banner> : null}
      {!draft ? <ErrorText error={error} /> : null}

      {draft && built ? (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
          <Card
            title={draft.id ? `Edit: ${draft.name || "campaign"}` : "New campaign"}
            action={
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)} disabled={!!busy}>
                Close
              </button>
            }
          >
            <CampaignEditor draft={draft} onChange={setDraft} band={band} brands={brands} isPlatform={isPlatform} />
            {built.errors.length ? (
              <div className="banner banner-warn mt-5" role="status">
                <span aria-hidden>⚠</span>
                <div>
                  <strong>Fix before saving:</strong>
                  <ul className="list-disc ml-5 mt-1">
                    {built.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            <ErrorText error={error} />
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!busy || built.errors.length > 0}
                onClick={() => save(built.campaign, draft.active, "editor", draft.id ? `Saved “${built.campaign.name}”.` : `Created “${built.campaign.name}”.`)}
              >
                {busy === "editor" ? "Saving…" : draft.id ? "Save changes" : "Create campaign"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          </Card>
          <div className="lg:sticky lg:top-24">
            <Card title="Try it">
              <BonusTryIt
                campaign={built.campaign}
                hasErrors={built.errors.length > 0}
                notLiveReason={notLive}
                phones={phones}
                brands={brands}
                defaultStoreKind={defaultStoreKind}
                today={today}
              />
            </Card>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ink-2 text-[14.5px]">
            {liveCount === 0
              ? "No campaign is live at the counter right now — customers who upgrade get the trade-in value only."
              : liveCount === 1
                ? "1 campaign is live at the counter."
                : `${liveCount} campaigns are live — the counter gives each customer whichever pays the most.`}
          </p>
          <button type="button" className="btn btn-up" onClick={() => setDraft(emptyDraft(band, today))}>
            + New campaign
          </button>
        </div>
      )}

      <div className="space-y-3">
        {list.length ? (
          list.map((c) => {
            const st = campaignStatus(c, today);
            const editingThis = draft?.id === c.id;
            return (
              <Card key={c.id} className={editingThis ? "outline-2 outline-offset-2 outline-[color:var(--fix)]" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-3 pt-2">
                  <div className="min-w-0">
                    <h3 className="text-[18px] font-[700] tracking-tight">{c.name}</h3>
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      <span className={`pill ${st.tone ? `pill-${st.tone}` : ""}`}>{st.label}</span>
                      <span className="pill">Band {bandText(c.minBp, c.maxBp)}</span>
                      <span className="pill">{c.capRupees === null ? "No ₹ cap" : <>Cap <Money value={c.capRupees} /></>}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!!busy}
                      onClick={() => save(c, !c.active, `toggle:${c.id}`, c.active ? `Paused “${c.name}”.` : `“${c.name}” is back on.`)}
                    >
                      {busy === `toggle:${c.id}` ? "Saving…" : c.active ? "Pause" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!!busy}
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setDraft(toDraft(c));
                        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 mt-4 text-[14px]">
                  <div>
                    <dt className="text-muted text-[12.5px]">Bonus is</dt>
                    <dd className="font-semibold">{basisLabel(c.basis)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted text-[12.5px]">Funded by</dt>
                    <dd className="font-semibold">{c.fundedBy || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted text-[12.5px]">Runs</dt>
                    <dd className="font-semibold">
                      {fmtDay(c.startsOn)} → {c.endsOn ? fmtDay(c.endsOn) : "until paused"}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <div className="section-title mb-1.5">Rules</div>
                  <ul className="divide-y divide-[color:var(--line)] border-y border-line">
                    {c.rules.map((r) => (
                      <li key={r.id} className="flex items-baseline gap-3 py-2 text-[14px]">
                        <span className="num font-semibold text-up w-14 shrink-0">+{fmtBp(r.bp)}</span>
                        <span className="min-w-0 flex-1">
                          {r.label}
                          <span className="text-muted"> — {describeCondition(r.when)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            );
          })
        ) : (
          <Card>
            <Empty title="No campaigns yet">Create one to offer an upgrade bonus at the counter.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}
