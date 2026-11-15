import { Card } from "@/components/ui";
import { webAppInfo } from "@/lib/server/downloads";
import { BluetoothGradingPanel } from "./BluetoothGradingPanel";

/**
 * The desk's way into SwapUp Check: the browser version of SwapUp Store
 * (/app/store/, same origin), which shows the Wi-Fi QR and the test QR and
 * watches the customer's results land, plus direct Web Bluetooth (BLE GATT)
 * connectivity to test and grade customer devices right from the counter.
 */
export function TestPhoneCard() {
  const web = webAppInfo("store");
  return (
    <div className="space-y-4">
      <Card title="Test the phone">
        <p className="text-[14.5px] text-ink-2 leading-relaxed">The customer scans a QR and tests their own phone, or pair directly over Bluetooth below.</p>
        {web ? (
          <>
            <a className="btn btn-primary mt-4 w-full whitespace-normal text-center" href={web.path} target="_blank" rel="noopener" data-choice="store-web">
              Open SwapUp Store
            </a>
            <p className="hint">Same login as this desk. Then start a new trade-in.</p>
          </>
        ) : (
          <p className="mt-3 text-warn text-[14px]">SwapUp Store web isn&apos;t published yet.</p>
        )}
        <p className="hint">
          Android? <a href="/downloads#store">Install SwapUp Store</a>.
        </p>
      </Card>

      <BluetoothGradingPanel caseId="new" compact />
    </div>
  );
}

