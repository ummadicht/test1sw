import { Card } from "@/components/ui";
import { webAppInfo } from "@/lib/server/downloads";

/**
 * The desk's way into SwapUp Check: the browser version of SwapUp Store
 * (/app/store/, same origin), which shows the Wi-Fi QR and the test QR and
 * watches the customer's results land. It signs in with its own token, not
 * this page's cookie — so staff sign in there once, with the same login.
 */
export function TestPhoneCard() {
  const web = webAppInfo("store");
  return (
    <Card title="Test the customer's phone">
      <p className="text-[14.5px] text-ink-2 leading-relaxed">
        The customer scans a QR and tests their own phone — in their browser, no install, or with the SwapUp Check app. Faults, model and storage
        land here on the case.
      </p>
      {web ? (
        <>
          <a className="btn btn-primary mt-4 w-full whitespace-normal text-center" href={web.path} target="_blank" rel="noopener" data-choice="store-web">
            Open SwapUp Store in this browser
          </a>
          <p className="hint">
            Same username and password as this desk — sign in once there. It keeps its own sign-in, separate from this page&apos;s. Then tap <b>New customer trade-in</b>.
          </p>
        </>
      ) : (
        <p className="mt-3 text-warn text-[14px]">The browser version of SwapUp Store is not published yet.</p>
      )}
      <p className="hint">
        On the counter&apos;s Android phone? <a href="/downloads#store">Install the SwapUp Store app</a>.
      </p>
    </Card>
  );
}
