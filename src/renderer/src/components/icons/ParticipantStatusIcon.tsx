/**
 * ParticipantStatusIcon — extracted from EnsembleParticipantsAboveRow so the
 * round close-out table can end each seat's work cell with the SAME glyph the
 * roster chip shows, not a lookalike and not an emoji. Both call sites pair it
 * with `.ensemble-above-chip-status status-<slug>`, which carries the colour,
 * so the two surfaces stay one vocabulary by construction.
 */
/**
 * Monoline status icon for a participant chip (1.0.3 polish).
 *
 * Replaces the pre-existing uppercase text labels ("IDLE", "SPEAKING",
 * "YIELDED", etc.) inside the chip's `.ensemble-above-chip-status`
 * pill. Each icon uses `stroke="currentColor"` so the existing
 * `.status-{name}` colour rules in main.css continue to drive the
 * tint — the icon naturally reads "yielded amber", "answered green",
 * etc. without per-icon hard-coded fills.
 *
 * 16x16 viewBox with 1.5 stroke width keeps the glyphs visually
 * consistent with the rest of the chip-strip iconography (the
 * provider badge SVGs use the same density). 13×13 rendered size is
 * roughly the visual weight of a single uppercase letter in the
 * pre-existing label — small enough to feel like a status hint, big
 * enough to read at glance.
 *
 * Status taxonomy mirrors `EnsembleParticipantStatus` plus the
 * synthetic `'speaking'` label the parent uses for the currently-
 * active participant:
 *   - speaking / running → megaphone (active output)
 *   - idle              → ZZZ stack (waiting its turn)
 *   - yielded           → curved-rightward handoff arrow (deliberate
 *                          pass — distinct from skip which is
 *                          involuntary)
 *   - answered          → checkmark (turn complete, content delivered)
 *   - failed            → warning triangle with !
 *   - skipped           → skip-forward double-triangle (passed over)
 *   - sleeping          → alarm clock (scheduled wakeup pending)
 *   - cancelled         → circle-slash (round-level cancel)
 *   - default           → ZZZ (unknown status falls through to idle
 *                          glyph for safety)
 */
export function ParticipantStatusIcon({ status }: { status: string }): React.JSX.Element {
  const key = status.toLowerCase()
  const baseSvgProps = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const
  }
  if (key === 'speaking' || key === 'running') {
    // Megaphone: rectangular body + flared mouth + two sound waves.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 6.5h2L10 4v8L5 9.5H3Z" />
        <path d="M3 6.5v3" />
        <path d="M12 6c.7 1 .7 3 0 4" />
        <path d="M13.8 4.5c1.1 1.6 1.1 5.4 0 7" />
      </svg>
    )
  }
  if (key === 'yielded') {
    // Curved handoff arrow: small leftward stem rises then arcs
    // rightward — "I'm done, the next person can go". Distinct from
    // a plain rightward arrow (which we use for skipped) so the
    // glyph reads as deliberate handoff vs forced skip.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 12V8a3 3 0 0 1 3-3h7" />
        <path d="m10 2.5 3 2.5-3 2.5" />
      </svg>
    )
  }
  if (key === 'answered') {
    // Plain checkmark. The .status-answered colour rule gives it the
    // success-green tint.
    return (
      <svg {...baseSvgProps}>
        <path d="m3 8.5 3.5 3.5L13 5" />
      </svg>
    )
  }
  if (key === 'failed') {
    // Warning triangle with exclamation.
    return (
      <svg {...baseSvgProps}>
        <path d="M8 2.5 14.5 13.5h-13z" />
        <path d="M8 7v3" />
        <path d="M8 12h.01" strokeWidth={2} />
      </svg>
    )
  }
  if (key === 'skipped') {
    // Skip-forward: two right-pointing triangles. Solid fill so it
    // reads as a media-control glyph even at 13px.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 4v8l5-4z" fill="currentColor" stroke="none" />
        <path d="M8.5 4v8l5-4z" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (key === 'cancelled') {
    // Circle-slash. The .status-cancelled colour rule keeps it in
    // the danger-tinted family.
    return (
      <svg {...baseSvgProps}>
        <circle cx="8" cy="8" r="5" />
        <path d="m4.7 11.3 6.6-6.6" />
      </svg>
    )
  }
  if (key === 'unreachable') {
    // 1.0.4-AD — broken-chain icon for participants the pre-flight
    // probe couldn't verify at round start. Two staggered link-shaped
    // ovals with a clear gap between them: reads as "connection
    // severed" at glance. The .status-unreachable colour rule (added
    // in main.css) carries the danger-amber tint so the pill stands
    // apart from `answered` (green) and `failed` (also amber but
    // mid-round rather than pre-flight). Hover tooltip wires the
    // `lastFailureReason` from the round state.
    return (
      <svg {...baseSvgProps}>
        <path d="M5.5 6.5a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h1.2" />
        <path d="M10.5 9.5a2 2 0 0 0 2-2v0a2 2 0 0 0-2-2H9.3" />
        <path d="m3 13 10-10" strokeWidth={1.3} />
      </svg>
    )
  }
  if (key === 'sleeping') {
    return (
      <svg {...baseSvgProps}>
        <circle cx="8" cy="8.5" r="4.5" />
        <path d="M5 2.5 3.5 4" />
        <path d="m11 2.5 1.5 1.5" />
        <path d="M8 6.5v2.2l1.6 1.2" />
        <path d="M5.5 14 4.7 15" />
        <path d="m10.5 14 .8 1" />
      </svg>
    )
  }
  // idle (default fall-through): three Z marks descending — dormant
  // / waiting. Drawn as nested polylines so the staircase is the
  // shape, not glyphs (avoids font-rendering inconsistencies).
  return (
    <svg {...baseSvgProps}>
      <path d="M9 3h3l-3 3h3" strokeWidth={1.2} />
      <path d="M5 7h4l-4 4h4" />
      <path d="M3 12h2l-2 2h2" strokeWidth={1.2} />
    </svg>
  )
}
