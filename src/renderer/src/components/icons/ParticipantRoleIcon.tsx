/**
 * Authority and stage-role glyphs for a participant seat.
 *
 * Extracted from `EnsembleParticipantsAboveRow`, where they were private, so
 * every surface that names a seat can show the same mark: the composer's
 * participant chips, the seat-change transcript row, the round close-out table,
 * the fan-out lane card, and the delegation/peer result cards.
 *
 * Runtime copies of the designer SVGs in `design-assets/ensemble-stage-roles/icons`.
 * Deliberately NOT ToolFamilyIcon: stage roles need distinct silhouettes at
 * 14px and are a separate visual concept from transcript tool calls.
 *
 * `currentColor` throughout, so a host tints the glyph by setting `color` —
 * which is how it picks up the seat's provider accent beside the role name.
 */

import type { EnsembleStageRole } from '../../../../main/store/types'
import type { EnsembleAuthorityRole } from '../../../../shared/ensembleAuthority'

/** Chat-level authority, which outranks a stage role on the same seat. */
export type SeatAuthority = EnsembleAuthorityRole

export function BossmanCrownIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function CaptainHatIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M9.3 8c.7-1.2 1.6-1.9 2.7-1.9s2 .7 2.7 1.9M10.1 11.4h3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4 16.4c1.9 1.3 4.6 2 8 2s6.1-.7 8-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function EnsembleStageRoleIcon({
  stageRole,
  className
}: {
  stageRole: EnsembleStageRole
  className?: string
}): React.JSX.Element {
  const baseSvgProps = {
    className,
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    focusable: 'false' as const
  }

  if (stageRole === 'scout') {
    return (
      <svg {...baseSvgProps}>
        <circle cx="10.1" cy="10.1" r="5.8" />
        <path d="m14.4 14.4 5.8 5.8" />
      </svg>
    )
  }
  if (stageRole === 'worker') {
    return (
      <svg {...baseSvgProps}>
        <path d="M15.2 4.1a5 5 0 0 0-6.1 6.4l-5.3 5.3a2.7 2.7 0 0 0 3.8 3.8l5.3-5.3a5 5 0 0 0 6.4-6.1" />
        <path d="m15.2 4.1-3.1 3.1.9 3.3 3.3.9 3-3.2" />
      </svg>
    )
  }
  if (stageRole === 'background') {
    return (
      <svg {...baseSvgProps}>
        <rect x="3.2" y="5" width="17.6" height="14" rx="2.2" />
        <path d="m7.2 10 2.6 2.2-2.6 2.2M12.2 14.4h4.6" />
      </svg>
    )
  }
  // reviewer
  return (
    <svg {...baseSvgProps}>
      <circle cx="7.3" cy="13.1" r="3.6" />
      <circle cx="16.7" cy="13.1" r="3.6" />
      <path d="M10.9 12.4c.7-.8 1.5-.8 2.2 0" />
      <path d="m3.8 11.7-1.3-3.2M20.2 11.7l1.3-3.2" />
    </svg>
  )
}

const STAGE_ROLE_TITLES: Record<EnsembleStageRole, string> = {
  scout: 'Scout',
  worker: 'Worker',
  reviewer: 'Reviewer',
  background: 'Background'
}

/**
 * The single glyph that identifies a seat, or null when it is an ordinary one.
 *
 * Authority outranks stage: a Boss who is also a Scout reads as the Boss,
 * matching the composer chips, where the crown replaces the stage badge rather
 * than sitting beside it. One mark per seat — two would make the roster harder
 * to scan, not easier.
 */
export function ParticipantRoleIcon({
  authority,
  stageRole,
  className
}: {
  authority?: SeatAuthority | null
  stageRole?: EnsembleStageRole | null
  className?: string
}): React.JSX.Element | null {
  if (authority === 'boss') {
    return <BossmanCrownIcon className={className} />
  }
  if (authority === 'captain') {
    return <CaptainHatIcon className={className} />
  }
  if (!stageRole) return null
  return <EnsembleStageRoleIcon stageRole={stageRole} className={className} />
}

/** Accessible name for the glyph, for hosts that surface it as a title. */
export function participantRoleIconTitle(
  authority?: SeatAuthority | null,
  stageRole?: EnsembleStageRole | null
): string {
  if (authority === 'boss') return 'Boss'
  if (authority === 'captain') return 'Captain'
  return stageRole ? STAGE_ROLE_TITLES[stageRole] : ''
}
