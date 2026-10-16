import { headers } from "next/headers";
import { openByCode, linksFor } from "@/lib/server/testSessions";
import { ensureSeeded } from "@/lib/server/seed";
import { apkInfo, mb, webAppInfo, webCheckUrl } from "@/lib/server/downloads";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Test your phone", robots: { index: false } };

/**
 * What the customer's phone opens when it scans the store's QR. Opening it
 * marks the session "opened" for the store's screen, and nothing else — a link
 * preview cannot bind the session; only a join (the app's, or the browser
 * test's when the customer presses Start) does.
 *
 * Three ways to test, in this order:
 *   1. In this browser — no install (/app/check/?code=…). The only way on an
 *      iPhone; SwapUp Check the app is Android-only.
 *   2. Install SwapUp Check (the APK) — the full native test set.
 *   3. Already installed? Open it (deep link), or type the code.
 */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  await ensureSeeded();
  const { code } = await params;
  const s = openByCode(code);
  const ua = (await headers()).get("user-agent") || "";
  const isIphone = /iPhone|iPad|iPod/i.test(ua);
  const base = process.env.SWAPUP_PUBLIC_URL || "";
  const apk = apkInfo("check");
  const web = webAppInfo("check");

  if (!s.ok) {
    return (
      <Shell>
        <section className="mt-10">
          <h1 className="text-[28px] leading-tight font-[780]">This code has expired</h1>
          <p className="mt-3 text-white/75 text-[16px] leading-relaxed">Ask the advisor at the counter for a new QR code, then scan it again.</p>
        </section>
      </Shell>
    );
  }

  const browserOption = (
    <Option
      id="browser"
      eyebrow={isIphone ? "For iPhone" : "Quickest · no install"}
      title="Test in this browser — no install"
      primary
    >
      {isIphone ? (
        <p className="mt-2 text-white/80 text-[15px] leading-relaxed">
          The SwapUp Check app is for Android phones only, so on an iPhone the test runs right here in Safari. Nothing to install.
        </p>
      ) : (
        <p className="mt-2 text-white/80 text-[15px] leading-relaxed">Runs right here in your browser. Nothing to install.</p>
      )}
      {web ? (
        <a
          href={webCheckUrl(s.code)}
          data-choice="browser"
          className="mt-3 flex items-center justify-center rounded-xl bg-[#3ddc97] text-[#06231a] font-[750] text-[17px] min-h-[54px] no-underline"
        >
          Start the test in this browser
        </a>
      ) : (
        <p className="mt-3 text-amber-300 text-[15px]">
          The browser test is not published yet — {isIphone ? "hand your iPhone to the advisor." : "install the app below, or ask the advisor."}
        </p>
      )}
      <ul className="mt-3 space-y-1.5 text-white/70 text-[14px] leading-relaxed list-disc pl-5">
        <li>When the browser asks for the camera, microphone or motion, tap Allow — the tests need them.</li>
        <li>
          A browser can&apos;t run every test. Those show as <b>&ldquo;Can&apos;t test this in a browser&rdquo;</b> and are never counted as passed
          {isIphone ? "." : " — the app below runs them."}
        </li>
      </ul>
    </Option>
  );

  const installOption = (
    <Option id="install" eyebrow="Full test set · Android" title="Install SwapUp Check">
      <p className="mt-2 text-white/80 text-[15px] leading-relaxed">The Android app runs every test, including the ones a browser can&apos;t.</p>
      {apk ? (
        <a
          href={`${base}/downloads/swapup-check.apk`}
          data-choice="install"
          className="mt-3 flex items-center justify-center rounded-xl bg-white/90 text-[color:var(--ink)] font-[750] text-[17px] min-h-[54px] no-underline"
        >
          Download the app · {mb(apk.bytes)}
        </a>
      ) : (
        <p className="mt-3 text-amber-300 text-[15px]">The app is not published yet — use the browser test above, or ask the advisor.</p>
      )}
      <ul className="mt-3 space-y-1.5 text-white/70 text-[14px] leading-relaxed list-disc pl-5">
        <li>
          If the browser asks, tap <b>Download anyway</b>, then open the file.
        </li>
        <li>
          If Android says installs from this browser are blocked: tap <b>Settings</b>, turn on <b>Allow from this source</b>, go back, then tap
          <b> Install</b>.
        </li>
        <li>No data? Join the store&apos;s Wi‑Fi first — the advisor has a Wi‑Fi QR.</li>
      </ul>
    </Option>
  );

  const openOption = (
    <Option id="open" eyebrow="Have the app?" title="Already installed? Open the app">
      <a
        href={linksFor(s.code, base || undefined).deepLink}
        data-choice="open"
        className="mt-3 flex items-center justify-center rounded-xl border border-white/40 text-white font-[750] text-[17px] min-h-[54px] no-underline"
      >
        Open SwapUp Check
      </a>
      <p className="mt-3 text-white/75 text-[14.5px]">If the button does nothing, open the app yourself and type this code:</p>
      <Code code={s.code} />
    </Option>
  );

  return (
    <Shell>
      <section className="mt-8">
        <p className="text-white/60 text-sm">{s.storeName}</p>
        <h1 className="text-[30px] leading-tight font-[780] mt-1">Test your phone for its trade-in value</h1>
        <p className="mt-3 text-white/75 text-[15.5px] leading-relaxed">
          About 5 minutes of quick tests — touch, screen, speaker, cameras. Nothing personal is read: no photos, contacts or messages leave the phone.
        </p>
      </section>

      <h2 className="mt-7 text-[13px] font-bold tracking-wider text-white/60 uppercase">Choose how to test</h2>
      {isIphone ? (
        <div className="mt-3 space-y-4">
          {browserOption}
          <p className="text-white/70 text-[14.5px] leading-relaxed px-1">
            If the browser test won&apos;t start, hand your iPhone to the advisor — they will test it at the counter.
          </p>
          <details className="rounded-2xl border border-white/15 px-5 py-4">
            <summary className="cursor-pointer font-semibold text-[15px] text-white/85">Not an iPhone? The Android app</summary>
            <div className="mt-4 space-y-4">
              {installOption}
              {openOption}
            </div>
          </details>
          <p className="text-white/60 text-[14px]">
            Your code <span className="font-mono text-[22px] tracking-[0.2em] font-bold text-white align-middle mx-1">{s.code}</span> — the same as on the
            advisor&apos;s screen.
          </p>
        </div>
      ) : (
        <ol className="mt-3 space-y-4 list-none p-0">
          <li>{browserOption}</li>
          <li>{installOption}</li>
          <li>{openOption}</li>
        </ol>
      )}

      <p className="mt-6 text-white/50 text-[13px]">Trade-in {s.caseRef}. Show the final screen to the advisor when you are done.</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[color:var(--ink)] text-white">
      <div className="max-w-md mx-auto px-5 py-8">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-bold">SwapUp Check</span>
        </div>
        {children}
      </div>
    </main>
  );
}

function Option({ id, eyebrow, title, primary, children }: { id: string; eyebrow: string; title: string; primary?: boolean; children: React.ReactNode }) {
  return (
    <section
      id={id}
      className={`rounded-2xl p-5 border ${primary ? "bg-white/12 border-[#3ddc97]/60" : "bg-white/8 border-white/15"}`}
    >
      <div className="text-[13px] font-bold tracking-wider text-[#3ddc97] uppercase">{eyebrow}</div>
      <h3 className="font-bold text-[18px] mt-1">{title}</h3>
      {children}
    </section>
  );
}

function Code({ code }: { code: string }) {
  return (
    <div className="mt-2 text-center font-mono text-[40px] tracking-[0.25em] font-bold" aria-label={`Code ${code.split("").join(" ")}`}>
      {code}
    </div>
  );
}
