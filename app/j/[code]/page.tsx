import { headers } from "next/headers";
import { openByCode, linksFor } from "@/lib/server/testSessions";
import { ensureSeeded } from "@/lib/server/seed";
import { apkInfo, mb, webAppInfo, webCheckUrl } from "@/lib/server/downloads";
import { Wordmark, PillArrow, headline } from "@/components/brand";
import { originFromHeaders } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const metadata = { title: "Test your phone", robots: { index: false } };
export const viewport = { themeColor: "#f4f4f6" };

/**
 * What the customer's phone opens when it scans the store's QR. Opening it
 * marks the session "opened" for the store's screen, and nothing else — a link
 * preview cannot bind the session; only a join (the app's, or the browser
 * test's when the customer presses Start) does.
 *
 * The code may also be a store's permanent COUNTER code (the QR on the
 * counter, docs/PHONE-LED-FLOW.md): the customer starts a trade-in alone. It
 * shows the store; there is no case yet — the phone's join makes one.
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
  const s = await openByCode(code);
  const h = await headers();
  const ua = h.get("user-agent") || "";
  const isIphone = /iPhone|iPad|iPod/i.test(ua);
  // SWAPUP_PUBLIC_URL in production; in dev the origin this page was opened on.
  const base = originFromHeaders(h) || "";
  const apk = apkInfo("check");
  const web = webAppInfo("check");

  if (!s.ok) {
    return (
      <Shell>
        <section className="mt-10">
          <Headline>This code has expired</Headline>
          <Lead>Ask the advisor for a new QR.</Lead>
        </section>
      </Shell>
    );
  }

  const browserOption = (
    <Option
      id="browser"
      eyebrow={isIphone ? "For iPhone" : "Quickest · no install"}
      title="Test in this browser"
      primary
    >
      {isIphone ? <p className="mt-2 text-[color:var(--xc-muted)] text-[15px] leading-relaxed">Runs here in Safari.</p> : null}
      {web ? (
        <a href={webCheckUrl(s.code)} data-choice="browser" className="xc-pill mt-4">
          <span>Start the test</span>
          <PillArrow />
        </a>
      ) : (
        <p className="mt-3 text-[color:var(--xc-warn)] text-[15px]">Not available yet — ask the advisor.</p>
      )}
      <Tips>
        <li>Tap Allow for the camera, microphone and motion.</li>
        <li>Tests a browser can&apos;t run never count as passed.</li>
      </Tips>
    </Option>
  );

  const installOption = (
    <Option id="install" eyebrow="Full test set · Android" title="Install SwapUp Check">
      <p className="mt-2 text-[color:var(--xc-muted)] text-[15px] leading-relaxed">Runs every test.</p>
      {apk ? (
        <a href={`${base}/downloads/swapup-check.apk`} data-choice="install" className="xc-pill-outline mt-4">
          <span>Download · {mb(apk.bytes)}</span>
          <PillArrow />
        </a>
      ) : (
        <p className="mt-3 text-[color:var(--xc-warn)] text-[15px]">Not available yet — use the browser test.</p>
      )}
      <Tips>
        <li>
          Tap <b>Download anyway</b>, then open the file.
        </li>
        <li>
          Blocked? <b>Settings</b> › <b>Allow from this source</b> › <b>Install</b>.
        </li>
        <li>No data? Ask for the store&apos;s Wi‑Fi QR.</li>
      </Tips>
    </Option>
  );

  const openOption = (
    <Option id="open" eyebrow="Have the app?" title="Open the app">
      <a href={linksFor(s.code, base || undefined).deepLink} data-choice="open" className="xc-pill-outline mt-4">
        <span>Open SwapUp Check</span>
        <PillArrow />
      </a>
      <p className="mt-3 text-[color:var(--xc-muted)] text-[14.5px]">Nothing happens? Type this code in the app:</p>
      <Code code={s.code} />
    </Option>
  );

  return (
    <Shell store={s.storeName}>
      <section className="mt-9">
        {s.joined ? (
          <>
            {/* The code works for one phone, and one already took it (SUP-262): said first; the options stay for that phone's resume. */}
            <Headline>Already connected to the customer&apos;s phone</Headline>
            <Lead>If this is that phone, carry on below. Testing another phone? Ask the advisor for a new code.</Lead>
          </>
        ) : (
          <>
            <Headline>Test your phone</Headline>
            <Lead>About 5 minutes — nothing personal leaves your phone.</Lead>
          </>
        )}
      </section>

      <h2 className="mt-8 text-[13px] font-bold tracking-[0.12em] text-[color:var(--xc-muted)] uppercase">Choose how to test</h2>
      {isIphone ? (
        <div className="mt-3 space-y-4">
          {browserOption}
          <p className="text-[color:var(--xc-muted)] text-[14.5px] leading-relaxed px-1">Won&apos;t start? Hand your iPhone to the advisor.</p>
          <details className="xc-card !py-4">
            <summary className="cursor-pointer font-semibold text-[15px]">Android app</summary>
            <div className="mt-2 space-y-2 -mx-[22px]">
              {installOption}
              {openOption}
            </div>
          </details>
          <p className="text-[color:var(--xc-muted)] text-[14px] px-1">
            Your code <span className="font-mono text-[22px] tracking-[0.2em] font-bold text-[color:var(--xc-ink)] align-middle mx-1">{s.code}</span>
          </p>
        </div>
      ) : (
        <ol className="mt-3 space-y-4 list-none p-0">
          <li>{browserOption}</li>
          <li>{installOption}</li>
          <li>{openOption}</li>
        </ol>
      )}

      <p className="mt-7 text-[color:var(--xc-muted)] text-[13px] px-1">
        {s.caseRef ? `Trade-in ${s.caseRef} · ` : ""}Show the advisor the last screen.
      </p>
    </Shell>
  );
}

/** Grey-tint page, the text wordmark centred on top with the store under it — no logo. */
function Shell({ store, children }: { store?: string | null; children: React.ReactNode }) {
  return (
    <main className="xc min-h-screen">
      <div className="max-w-md mx-auto px-5 pt-9 pb-10">
        <Wordmark store={store} />
        {children}
      </div>
    </main>
  );
}

function Headline({ children }: { children: React.ReactNode }) {
  return <h1 className={`${headline.className} text-[31px] leading-[1.12] font-extrabold tracking-[-0.02em]`}>{children}</h1>;
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[color:var(--xc-muted)] text-[16.5px] leading-relaxed">{children}</p>;
}

function Option({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; primary?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} className="xc-card">
      <div className="text-[12.5px] font-bold tracking-[0.1em] text-[color:var(--xc-blue)] uppercase">{eyebrow}</div>
      <h3 className={`${headline.className} font-bold text-[19px] mt-1 leading-snug`}>{title}</h3>
      {children}
    </section>
  );
}

/** Help that only some need — closed until tapped. */
function Tips({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-4 text-[color:var(--xc-muted)] text-[14px] leading-relaxed">
      <summary className="cursor-pointer font-semibold text-[color:var(--xc-blue)]">Help</summary>
      <ul className="mt-1.5 space-y-1.5 list-disc pl-5">{children}</ul>
    </details>
  );
}

function Code({ code }: { code: string }) {
  return (
    <div className="mt-2 text-center font-mono text-[40px] tracking-[0.25em] font-bold" aria-label={`Code ${code.split("").join(" ")}`}>
      {code}
    </div>
  );
}
