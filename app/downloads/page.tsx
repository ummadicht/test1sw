import { apkInfo, mb } from "@/lib/server/downloads";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Download the apps" };

const APPS = [
  { app: "store" as const, name: "SwapUp Store", who: "For store staff — sign in with your SwapUp account on the counter tablet or phone." },
  { app: "check" as const, name: "SwapUp Check", who: "For customers — the store's QR code opens this download for them." },
];

export default function Downloads() {
  return (
    <main className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-5 py-10">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-bold">SwapUp for Android</span>
        </div>
        <div className="mt-8 space-y-4">
          {APPS.map((a) => {
            const info = apkInfo(a.app);
            return (
              <section key={a.app} className="card card-pad">
                <h2 className="text-[19px] font-bold">{a.name}</h2>
                <p className="hint !mt-1 text-[14.5px]">{a.who}</p>
                {info ? (
                  <>
                    <a className="btn btn-primary mt-4" href={`/downloads/swapup-${a.app}.apk`}>
                      Download {a.name} · v{info.version} · {mb(info.bytes)}
                    </a>
                    <p className="hint num break-all">
                      Built {info.builtAt.slice(0, 10)} · SHA-256 {info.sha256}
                    </p>
                  </>
                ) : (
                  <p className="mt-3 text-warn text-[14.5px]">Not published yet.</p>
                )}
              </section>
            );
          })}
        </div>
        <p className="hint mt-6 text-[14px]">
          These apps are installed directly, not from the Play Store. Android will ask you to allow installs from your browser the first time: Settings →
          Install unknown apps → your browser → Allow. Both apps are signed with the same SwapUp key, so updates install over the old version.
        </p>
      </div>
    </main>
  );
}
