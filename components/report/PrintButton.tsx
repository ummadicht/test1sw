"use client";

/** "Print / PDF" on the public report — the browser's own print. Hidden on paper. */
export function PrintButton({ className = "" }: { className?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={`no-print ${className}`}>
      Print / PDF
    </button>
  );
}
