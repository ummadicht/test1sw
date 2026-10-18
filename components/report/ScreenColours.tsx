import type { ReportView } from "@/components/counter/gradingView";
import { MarkBoxes } from "./PhotoEvidence";

/**
 * THE SCREEN COLOUR TEST on the grade report — the colours the store camera
 * asked the customer's phone to show, as a row of swatches marked ✓ (a frame was
 * taken) or – (none), then the frames themselves with the reader's marks boxed,
 * then what decided it in plain words: the camera's result, or why it couldn't
 * check (one fixed sentence), and who checked the screen by hand. The frames are
 * crops of the lit screen only. Server-rendered, no script, prints.
 */

const SWATCH: Readonly<Record<string, string>> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#00c000",
  blue: "#0040ff",
  grey: "#808080",
  gray: "#808080",
  stripes: "repeating-linear-gradient(90deg,#000 0 4px,#fff 4px 8px)",
};

export function ScreenColours({ screen }: { screen: NonNullable<ReportView["screen"]> }) {
  const frames = screen.colours.filter((c) => c.photo);
  return (
    <div>
      {screen.colours.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={screen.count}>
          {screen.colours.map((c) => (
            <li key={c.pattern} className="flex items-center gap-1.5 rounded-full border border-[color:var(--rv-line)] pl-1 pr-2.5 py-0.5 text-[13px]">
              <span aria-hidden className="inline-block w-4 h-4 rounded-full border border-[color:var(--rv-line)]" style={{ background: SWATCH[c.pattern] ?? "var(--rv-soft)" }} />
              <span>{c.name}</span>
              <span className={c.photo ? "font-bold text-[color:var(--rv-up)]" : "text-[color:var(--rv-muted)]"}>{c.photo ? "✓" : "–"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-[13px] text-[color:var(--rv-muted)]">{screen.count}.</p>
      {frames.length ? (
        <ul className="mt-2.5 grid grid-cols-3 sm:grid-cols-4 print:grid-cols-6 gap-2">
          {frames.map((c) => (
            <li key={c.pattern} className="min-w-0 print:break-inside-avoid">
              <span className="relative inline-block w-full overflow-hidden rounded-[8px] bg-[color:var(--rv-soft)] align-top">
                {/* eslint-disable-next-line @next/next/no-img-element -- streamed by SwapUp from the camera's store; nothing to optimise */}
                <img src={c.photo!} alt={`The lit screen showing ${c.name.toLowerCase()}`} loading="lazy" className="block w-full h-auto" />
                <MarkBoxes marks={c.marks} />
              </span>
              <div className="mt-0.5 text-[12px] text-[color:var(--rv-muted)]">{c.name}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {screen.lines.length ? (
        <ul className="mt-2.5 space-y-0.5 text-[14px] leading-snug">
          {screen.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
