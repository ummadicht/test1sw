import { headers } from "next/headers";
import { openByCode, linksFor } from "@/lib/server/testSessions";
import { ensureSeeded } from "@/lib/server/seed";
import { apkInfo, mb } from "@/lib/server/downloads";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Test your phone", robots: { index: false } };

/**
 * What the customer's phone opens when it scans the store's QR. Opening it
 * marks the session "opened" for the store's screen, and nothing else — a link
 * preview cannot bind the session; only the app's join does.
 */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  await ensureSeeded();
  const { code } = await params;
  const s = openByCode(code);
  const ua = (await headers()).get("user-agent") || "";
  const isIphone = /iPhone|iPad|iPod/i.test(ua);
  const base = process.env.SWAPUP_PUBLIC_URL || "";
  const apk = apkInfo("check");

  return (
    <main className="min-h-screen bg-[color:var(--ink)] text-white">
      <div className="max-w-md mx-auto px-5 py-8">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-bold">SwapUp Check</span>
        </div>

        {!s.ok ? (
          <section className="mt-10">
            <h1 className="text-[28px] leading-tight font-[780]">This code has expired</h1>
            <p className="mt-3 text-white/75 text-[16px] leading-relaxed">Ask the advisor at the counter for a new QR code, then scan it again.</p>
          </section>
        ) : (
          <>
            <section className="mt-8">
              <p className="text-white/60 text-sm">{s.storeName}</p>
              <h1 className="text-[30px] leading-tight font-[780] mt-1">Test your phone for its trade-in value</h1>
              <p className="mt-3 text-white/75 text-[15.5px] leading-relaxed">
                About 5 minutes of quick tests — touch, screen, speaker, cameras, charging. Nothing personal is read: no photos, contacts or messages leave the phone.
              </p>
            </section>

            {isIphone ? (
              <section className="mt-7 rounded-2xl bg-white/8 border border-white/15 p-5">
                <h2 className="font-bold text-[17px]">On an iPhone?</h2>
                <p className="mt-2 text-white/75 text-[15px] leading-relaxed">
                  SwapUp Check is for Android phones. Hand your iPhone to the advisor — they will test it at the counter.
                </p>
              </section>
            ) : null}

            <ol className="mt-7 space-y-4">
              <li className="rounded-2xl bg-white/8 border border-white/15 p-5">
                <div className="text-[13px] font-bold tracking-wider text-[#3ddc97] uppercase">Step 1</div>
                <h2 className="font-bold text-[18px] mt-1">Install SwapUp Check</h2>
                {apk ? (
                  <a
                    href={`${base}/downloads/swapup-check.apk`}
                    className="mt-3 flex items-center justify-center rounded-xl bg-[#3ddc97] text-[#06231a] font-[750] text-[17px] min-h-[54px] no-underline"
                  >
                    Download the app · {mb(apk.bytes)}
                  </a>
                ) : (
                  <p className="mt-2 text-amber-300 text-[15px]">The app is not published yet — ask the advisor.</p>
                )}
                <ul className="mt-3 space-y-1.5 text-white/75 text-[14.5px] leading-relaxed list-disc pl-5">
                  <li>If the browser asks, tap <b>Download anyway</b>, then open the file.</li>
                  <li>
                    If Android says installs from this browser are blocked: tap <b>Settings</b>, turn on <b>Allow from this source</b>, go back, then tap
                    <b> Install</b>.
                  </li>
                  <li>No data? Join the store&apos;s Wi‑Fi first — the advisor has a Wi‑Fi QR.</li>
                </ul>
              </li>

              <li className="rounded-2xl bg-white/8 border border-white/15 p-5">
                <div className="text-[13px] font-bold tracking-wider text-[#3ddc97] uppercase">Step 2</div>
                <h2 className="font-bold text-[18px] mt-1">Open it and start</h2>
                <a
                  href={linksFor(s.code, base || undefined).deepLink}
                  className="mt-3 flex items-center justify-center rounded-xl bg-white text-[color:var(--ink)] font-[750] text-[17px] min-h-[54px] no-underline"
                >
                  Open SwapUp Check
                </a>
                <p className="mt-3 text-white/75 text-[14.5px]">If the button does nothing, open the app yourself and type this code:</p>
                <div className="mt-2 text-center font-mono text-[40px] tracking-[0.25em] font-bold">{s.code}</div>
              </li>
            </ol>

            <p className="mt-6 text-white/50 text-[13px]">Trade-in {s.caseRef}. Show the final screen to the advisor when you are done.</p>
          </>
        )}
      </div>
    </main>
  );
}
