"use client";

import Link from "next/link";

/** The only chrome on a printable page: back, and print. Hidden on paper. */
export function PrintBar({ back, label = "Print" }: { back: string; label?: string }) {
  return (
    <div className="no-print flex items-center justify-between gap-3 mb-5">
      <Link href={back} className="btn btn-sm btn-ghost">
        ← Back
      </Link>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => window.print()}>
        {label}
      </button>
    </div>
  );
}
