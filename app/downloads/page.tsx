import { apkInfo, mb, webAppInfo, type AppId } from "@/lib/server/downloads";
import { Wordmark, PillArrow, headline } from "@/components/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Download the apps" };

const APPS: { app: AppId; name: string; who: string }[] = [
  { app: "store", name: "SwapUp Store", who: "For store staff." },
  { app: "check", name: "SwapUp Check", who: "For customers — the store's QR opens it." },
];

export default function Downloads() {
  return (
    <main className="xc min-h-screen">
      <div className="max-w-2xl mx-auto px-5 py-10">
        <Wordmark align="left" />
        <h1 className={`${headline.className} mt-4 text-[30px] leading-tight font-extrabold tracking-[-0.02em]`}>Download the apps</h1>
        <p className="hint !mt-3 text-[14.5px]">Android app, or the browser — no install.</p>
        <div className="mt-6 space-y-4">
          {APPS.map((a) => {
            const info = apkInfo(a.app);
            const web = webAppInfo(a.app);
            return (
              <section key={a.app} className="xc-card" id={a.app}>
                <h2 className="text-[19px] font-bold">{a.name}</h2>
                <p className="hint !mt-1 text-[14.5px]">{a.who}</p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="section-title">Android app</div>
                    {info ? (
                      <>
                        <a className="xc-pill mt-2 !text-[15.5px]" href={`/downloads/swapup-${a.app}.apk`}>
                          <span>
                            Download · v{info.version} · {mb(info.bytes)}
                          </span>
                          <PillArrow />
                        </a>
                        <p className="hint num break-all">
                          Built {info.builtAt.slice(0, 10)} · SHA-256 {info.sha256}
                        </p>
                      </>
                    ) : (
                      <p className="mt-2 text-warn text-[14.5px]">Not published yet.</p>
                    )}
                  </div>

                  <div>
                    <div className="section-title">In the browser</div>
                    {a.app === "store" ? (
                      web ? (
                        <>
                          <a className="xc-pill-outline mt-2 !text-[15.5px]" href={web.path}>
                            <span>Open in your browser</span>
                            <PillArrow />
                          </a>
                          <p className="hint">Same login as this site.</p>
                          <WebVersion version={web.version} builtAt={web.builtAt} />
                        </>
                      ) : (
                        <p className="mt-2 text-warn text-[14.5px]">Not published yet.</p>
                      )
                    ) : web ? (
                      <p className="mt-2 text-[14.5px] leading-relaxed">
                        Opens from the store&apos;s QR.
                        <WebVersion version={web.version} builtAt={web.builtAt} />
                      </p>
                    ) : (
                      <p className="mt-2 text-warn text-[14.5px]">Not published yet.</p>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
        <details className="hint mt-6 text-[14px]">
          <summary className="cursor-pointer font-semibold">Install help</summary>
          <p className="mt-1.5">Not on the Play Store. First time: Settings → Install unknown apps → your browser → Allow.</p>
        </details>
      </div>
    </main>
  );
}

/** What the web builder's version.json said, if it wrote one. */
function WebVersion({ version, builtAt }: { version: string | null; builtAt: string | null }) {
  const parts = [version ? (/^\d/.test(version) ? `v${version}` : version) : null, builtAt ? `built ${builtAt.slice(0, 10)}` : null].filter(Boolean);
  return parts.length ? <span className="hint num block">{parts.join(" · ")}</span> : null;
}
