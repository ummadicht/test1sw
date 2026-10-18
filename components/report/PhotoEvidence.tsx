import type { Mark, ReportView, Tone } from "@/components/counter/gradingView";

/**
 * THE STORE CAMERA'S PHOTOS on the grade report — every exterior photo, labelled
 * by the angle it was taken at, with each mark a FINAL grade found boxed and
 * coloured by how bad it is, and the count per photo. Rendered on the server:
 * percentage boxes over a relative inline-block image, so it needs no script and
 * prints. Photos come through SwapUp's proxy (/api/r/<token>/photo/<n>), never
 * the camera store's own URL.
 *
 * When the camera couldn't grade them the photos still show, unboxed, with the
 * caption saying why — and who recorded the condition by eye instead.
 */

const BOX_TONE: Readonly<Record<Tone, string>> = {
  bad: "border-[color:var(--rv-bad)]",
  warn: "border-[color:var(--rv-warn)]",
  up: "border-[color:var(--rv-up)]",
  plain: "border-white",
};

export function MarkBoxes({ marks }: { marks: Mark[] }) {
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          title={m.what}
          aria-hidden
          className={`absolute border-2 rounded-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${BOX_TONE[m.tone]}`}
          style={{ top: `${m.top}%`, left: `${m.left}%`, width: `${m.width}%`, height: `${m.height}%` }}
        />
      ))}
    </>
  );
}

export function PhotoEvidence({ camera }: { camera: ReportView["camera"] }) {
  if (!camera.photos.length) return camera.caption ? <p className="mt-3 text-[14px] text-[color:var(--rv-muted)]">{camera.caption}</p> : null;
  return (
    <div className="mt-3">
      <ul className="grid grid-cols-2 sm:grid-cols-3 print:grid-cols-3 gap-2.5">
        {camera.photos.map((p) => (
          <li key={p.n} className="min-w-0 print:break-inside-avoid">
            <figure className="m-0">
              <span className="relative inline-block w-full overflow-hidden rounded-[10px] bg-[color:var(--rv-soft)] align-top">
                {/* eslint-disable-next-line @next/next/no-img-element -- streamed by SwapUp from the camera's store; nothing to optimise */}
                <img src={p.src} alt={`${p.label}${p.marks.length ? `, ${p.marks.map((m) => m.what).join(", ")}` : ""}`} loading="lazy" className="block w-full h-auto" />
                <MarkBoxes marks={p.marks} />
              </span>
              <figcaption className="mt-1 flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-semibold">{p.label}</span>
                <span className="text-[color:var(--rv-muted)]">{camera.caption ? "" : p.marks.length ? `${p.marks.length} mark${p.marks.length === 1 ? "" : "s"}` : "No marks"}</span>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {camera.caption ? <p className="mt-2 text-[13px] text-[color:var(--rv-muted)] leading-snug">{camera.caption}</p> : null}
    </div>
  );
}
