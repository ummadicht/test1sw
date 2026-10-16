import { apkInfo, mb, webAppInfo, type AppId } from "@/lib/server/downloads";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Download the apps" };

const APPS: { app: AppId; name: string; who: string }[] = [
  { app: "store", name: "SwapUp Store", who: "For store staff — sign in with your SwapUp account on the counter tablet, phone or computer." },
  { app: "check", name: "SwapUp Check", who: "For customers — the store's QR code opens it on the customer's own phone." },
];

export default function Downloads() {
  return (
    <main className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-5 py-10">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-bold">SwapUp apps — Android and browser</span>
        </div>
        <p className="hint !mt-3 text-[14.5px]">
          Each app comes two ways from the same code: an Android app to install, and a browser version that needs no install and works on any phone,
          iPhones included. The Android app can run more tests; the browser marks what it cannot test as &ldquo;Can&apos;t test this in a browser&rdquo;,
          never as passed.
        </p>
        <div className="mt-6 space-y-4">
          {APPS.map((a) => {
            const info = apkInfo(a.app);
            const web = webAppInfo(a.app);
            return (
              <section key={a.app} className="card card-pad" id={a.app}>
                <h2 className="text-[19px] font-bold">{a.name}</h2>
                <p className="hint !mt-1 text-[14.5px]">{a.who}</p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="section-title">Android app</div>
                    {info ? (
                      <>
                        <a className="btn btn-primary mt-2 whitespace-normal text-center" href={`/downloads/swapup-${a.app}.apk`}>
                          Download · v{info.version} · {mb(info.bytes)}
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
                          <a className="btn mt-2 whitespace-normal text-center" href={web.path}>
                            Open SwapUp Store in your browser
                          </a>
                          <p className="hint">Sign in with the same username and password as this site.</p>
                          <WebVersion version={web.version} builtAt={web.builtAt} />
                        </>
                      ) : (
                        <p className="mt-2 text-warn text-[14.5px]">Not published yet.</p>
                      )
                    ) : web ? (
                      <p className="mt-2 text-[14.5px] leading-relaxed">
                        SwapUp Check runs in the browser from the store&apos;s QR: the customer scans it and taps{" "}
                        <b>Test in this browser — no install</b>. It needs that QR&apos;s code, so there is no link to open here.
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
        <p className="hint mt-6 text-[14px]">
          The Android apps are installed directly, not from the Play Store. Android will ask you to allow installs from your browser the first time:
          Settings → Install unknown apps → your browser → Allow. Both apps are signed with the same SwapUp key, so updates install over the old version.
          The browser versions update by themselves.
        </p>
      </div>
    </main>
  );
}

/** What the web builder's version.json said, if it wrote one. */
function WebVersion({ version, builtAt }: { version: string | null; builtAt: string | null }) {
  const parts = [version ? (/^\d/.test(version) ? `v${version}` : version) : null, builtAt ? `built ${builtAt.slice(0, 10)}` : null].filter(Boolean);
  return parts.length ? <span className="hint num block">{parts.join(" · ")}</span> : null;
}
