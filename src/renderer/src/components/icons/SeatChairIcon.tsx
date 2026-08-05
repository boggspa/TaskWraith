/**
 * SeatChairIcon — monoline ladder-back chair for authoritative ensemble
 * seat-change rows in the transcript (owner pick 2026-08-05: "A ladder back
 * wins"). Scale and stroke weight match `BossmanCrownIcon` / `CaptainHatIcon`
 * (EnsembleParticipantsAboveRow.tsx) — this glyph is their peer in the
 * authority-iconography set and may be reused for Bossman Control. The
 * silhouette is the one visually approved in the seat-change row mock: tall
 * back post, mid-back ladder rung, seat slab with a right apron, two legs.
 */
export function SeatChairIcon({ className }: { className?: string } = {}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M7 4v9" />
      <path d="M7 8.5h5.5" />
      <path d="M7 13h12.5v4.5" />
      <path d="M8.5 17.5v2.5M18 17.5v2.5" />
    </svg>
  )
}
