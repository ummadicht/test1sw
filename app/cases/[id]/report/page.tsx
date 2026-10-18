import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { requirePage } from "@/lib/server/page";
import { HttpError } from "@/lib/server/auth";
import { originFromHeaders } from "@/lib/server/http";
import { gradingReportFor, publicReport, type ReportEnvelope, type StaffExtras } from "@/lib/server/gradingReport";
import type { Grading } from "@/lib/domain/grading";
import { PrintBar } from "@/components/counter/PrintBar";
import { GradingReportView } from "@/components/report/GradingReportView";
import { absoluteUrl, pinnedPath, REASON_WORD, shortHash, tokenOf, when } from "@/components/counter/gradingView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grade report" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas print:bg-white py-6 px-4 print:p-0">
      <style>{`@page { size: A4; margin: 12mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mx-auto max-w-[780px]">{children}</div>
    </div>
  );
}

function Message({ title, children, back }: { title: string; children?: React.ReactNode; back: string }) {
  return (
    <Shell>
      <div className="card card-pad text-center">
        <div className="text-[18px] font-semibold">{title}</div>
        {children ? <div className="hint mt-1">{children}</div> : null}
        <Link href={back} className="btn btn-sm mt-4">
          ← Back
        </Link>
      </div>
    </Shell>
  );
}

/**
 * THE GRADE REPORT, AT THE DESK — the same report the public link shows
 * (components/report/GradingReportView.tsx renders both from the body), to print
 * or hand over, plus a STAFF ONLY section that never prints: the versions, the
 * customer's link, the full IMEI, the store camera's own letter and links,
 * Phonecheck's links, and the grade the store margin's sell price is looked up at.
 *
 * Who sees what is lib/server/gradingReport.ts gradingReportFor (spec §4.4):
 * staff get the latest version (or ?v=n) and the extras; the buyback partner
 * gets only the version frozen at hand-over — never the live grade, never an
 * earlier version — and a 404 before the trade-in, like the case.
 */
export default async function CaseReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string | string[] }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const u = await requirePage(null, `/cases/${id}/report`);
  let r: ReturnType<typeof gradingReportFor>;
  try {
    r = gradingReportFor(u, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404)
      return (
        <Message title="Report not found" back="/">
          Another store&apos;s case, or not traded in yet.
        </Message>
      );
    throw e;
  }

  const isStaff = r.staff !== null;
  const token = tokenOf(r.path);
  let env: ReportEnvelope | null = r.issued;
  // Staff may open any earlier version; the partner only ever the frozen one.
  const asked = typeof sp.v === "string" ? sp.v : null;
  if (isStaff && token && asked && env && asked !== String(env.version)) {
    try {
      env = publicReport(token, asked);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return <Message title={`There is no version ${asked}`} back={`/cases/${id}/report`} />;
      throw e;
    }
  }

  if (!env || !token) {
    return (
      <Message title="No grade report yet" back={`/cases/${id}`}>
        Issued once the phone is tested.
      </Message>
    );
  }

  const origin = originFromHeaders(await headers()) ?? "";
  const url = absoluteUrl(origin, pinnedPath(`/r/${token}`, env.version));
  const qr = { dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: "M" }), url };
  const latest = r.versions.length ? r.versions[r.versions.length - 1].version : env.version;

  return (
    <Shell>
      <PrintBar back={`/cases/${id}`} label="Print report" />
      <div className="mb-4">
        <div className="section-title">{env.body.case.store}</div>
        <h1 className="text-[22px] font-[760] tracking-tight leading-tight">
          Grade report · <span className="num">{env.body.case.ref}</span>
        </h1>
        <p className="text-[13px] text-muted">
          Version {env.version}
          {env.version !== latest ? ` of ${latest} — an earlier version` : ""}
          {env.final ? " · frozen at hand-over" : ""}
        </p>
      </div>
      <GradingReportView env={env} token={token} variant="desk" qr={qr} />
      {isStaff ? <StaffOnly id={id} live={r.live} staff={r.staff!} versions={r.versions} shown={env} latestPath={absoluteUrl(origin, `/r/${token}`)} /> : null}
    </Shell>
  );
}

function StaffOnly({
  id,
  live,
  staff,
  versions,
  shown,
  latestPath,
}: {
  id: string;
  live: Grading | null;
  staff: StaffExtras;
  versions: ReturnType<typeof gradingReportFor>["versions"];
  shown: ReportEnvelope;
  latestPath: string;
}) {
  const cam = staff.camera;
  const pc = staff.phonecheck;
  const isLatest = versions.length > 0 && versions[versions.length - 1].version === shown.version;
  return (
    <section className="card card-pad mt-6 no-print border-dashed" aria-labelledby="staff-only">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="staff-only" className="text-[17px] font-[720]">
          Staff only
        </h2>
        <span className="pill pill-warn">Not printed</span>
      </div>

      {staff.outOfDate && isLatest && live ? (
        <div className="banner banner-warn mt-3">
          <span aria-hidden>⚠</span>
          <div>
            Case grade now <strong>{live.label}</strong>; this version says <strong>{shown.body.grade.label}</strong>.
          </div>
        </div>
      ) : null}

      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-[14px] mt-4">
        <div>
          <dt className="text-muted text-[12.5px]">Sell price looked up at</dt>
          <dd className="font-semibold">{staff.afterRefurb ? staff.afterRefurb.label : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted text-[12.5px]">IMEI (full)</dt>
          <dd className="num">
            {staff.imei ?? "—"}
            {staff.imei2 ? <div>{staff.imei2}</div> : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted text-[12.5px]">Customer&apos;s link</dt>
          <dd className="num text-[13px] break-all">{latestPath}</dd>
        </div>
      </dl>

      <div className="mt-5">
        <div className="section-title mb-1.5">Versions</div>
        <div className="overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead>
              <tr>
                <th>Version</th>
                <th>Issued</th>
                <th>Why</th>
                <th>sha256</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((x) => (
                <tr key={x.version}>
                  <td className="num font-semibold">
                    v{x.version}
                    {x.final ? <span className="pill pill-up ml-2">final</span> : null}
                  </td>
                  <td>{when(x.issuedAt)}</td>
                  <td className="text-[13px]">{REASON_WORD[x.reason] ?? x.reason}</td>
                  <td className="num text-[12.5px]">{shortHash(x.sha256)}</td>
                  <td className="text-right whitespace-nowrap">
                    {x.version === shown.version ? (
                      <span className="text-muted text-[13px]">shown</span>
                    ) : (
                      <Link href={`/cases/${id}/report?v=${x.version}`} className="text-[13px] font-semibold text-fix hover:underline">
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {cam ? (
        <div className="mt-5">
          <div className="section-title mb-1.5">Store camera (GradeIQ)</div>
          <p className="text-[14px]">
            Camera letter: <strong>{cam.gradeiqLetter ?? "—"}</strong>
            {cam.score !== null ? <> · score {cam.score}</> : null}
            <span className="hint block !mt-0">
              Camera&apos;s own scale — not the SwapUp grade.
            </span>
          </p>
          {cam.components.length ? (
            <ul className="flex flex-wrap gap-1.5 mt-2">
              {cam.components.map((c) => (
                <li key={c.id} className="pill">
                  {c.label} {c.grade || "—"}
                </li>
              ))}
            </ul>
          ) : null}
          {cam.flags.length ? (
            <ul className="list-disc pl-5 mt-2 text-[13.5px]">
              {cam.flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
          {cam.disagreements.length ? (
            <div className="mt-2">
              <div className="text-[13px] font-semibold">Disagreements</div>
              <ul className="list-disc pl-5 text-[13.5px]">
                {cam.disagreements.map((d, i) => (
                  <li key={`${d.topic}-${i}`}>{d.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {cam.gradeiq ? (
            <div className="flex flex-wrap gap-3 mt-2 text-[13px]">
              <a href={cam.gradeiq.report} target="_blank" rel="noreferrer noopener" className="font-semibold text-fix hover:underline">
                GradeIQ report ↗
              </a>
              <a href={cam.gradeiq.devicefax} target="_blank" rel="noreferrer noopener" className="font-semibold text-fix hover:underline">
                DeviceFax export ↗
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {pc ? (
        <div className="mt-5">
          <div className="section-title mb-1.5">Phonecheck record</div>
          <p className="text-[14px]">
            <span className="num">{pc.recordId}</span> · {pc.aiRead ? "AI-read upload — check figures" : pc.source === "pull" ? "pulled" : pc.source === "webhook" ? "sent by Phonecheck" : "uploaded JSON"}
            {pc.testerGrade ? <> · tester&apos;s grade {pc.testerGrade} (not used)</> : null}
          </p>
          {pc.imeiOverride ? (
            <p className="text-[13.5px] text-warn mt-1">
              Attached with a different IMEI by {pc.imeiOverride.by}, {when(pc.imeiOverride.at)}: “{pc.imeiOverride.reason}”
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3 mt-2 text-[13px]">
            {pc.links.a4 ? <ExtLink href={pc.links.a4}>A4 report ↗</ExtLink> : null}
            {pc.links.erasure ? <ExtLink href={pc.links.erasure}>Erasure report ↗</ExtLink> : null}
            {pc.links.dhr ? <ExtLink href={pc.links.dhr}>Device history ↗</ExtLink> : null}
            {!pc.links.a4 && !pc.links.erasure && !pc.links.dhr ? <span className="text-muted">No links.</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Phonecheck's links open in Phonecheck's own portal (they may ask for a Phonecheck sign-in). https only. */
function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!/^https:\/\//i.test(href)) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-semibold text-fix hover:underline">
      {children}
    </a>
  );
}
