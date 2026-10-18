import { Wordmark, headline } from "@/components/brand";

/** A report link that doesn't open: a wrong or partial link, or a version that doesn't exist. 404, in the customer brand. */
export default function ReportNotFound() {
  return (
    <main className="xc min-h-screen">
      <div className="max-w-md mx-auto px-5 pt-9 pb-10">
        <Wordmark />
        <section className="mt-10">
          <h1 className={`${headline.className} text-[29px] leading-[1.12] font-extrabold tracking-[-0.02em]`}>This link doesn&apos;t open</h1>
          <p className="mt-3 text-[color:var(--xc-muted)] text-[16.5px] leading-relaxed">
            Scan the QR on your receipt again, or ask the store.
          </p>
        </section>
      </div>
    </main>
  );
}
