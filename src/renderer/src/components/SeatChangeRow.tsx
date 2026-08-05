import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage, ProviderId, SeatChangeSeatState } from '../../../main/store/types'
import {
  TriggerReasoningSuffix,
  chipReasoningSparkleTier,
  modelPickerHueClass
} from './CombinedModelPicker'
import { CharOdometer } from './CharOdometer'
import { SeatChairIcon } from './icons/SeatChairIcon'
import {
  ParticipantRoleIcon,
  participantRoleIconTitle
} from './icons/ParticipantRoleIcon'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { getProviderName } from './Sidebar'
import { resolveProviderBrandLabel } from '../lib/ollamaDisplayBrand'
import { humaniseModelId } from '../lib/modelDisplayName'
import { reasoningDisplayLabel } from '../lib/composerChipFormat'
import { composerPermissionOptions } from '../lib/planModeLabels'
import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'
import type { SeatChangeLink, SeatChangePayload } from '../../../shared/seatChange'

/**
 * SeatChangeRow — the authoritative seat-change transcript element (owner spec
 * 2026-08-05). Renders like a bare tool call: chair glyph, then the seat's
 * provider/model/reasoning cluster and permission chip using the composer's
 * OWN trigger classes (`.composer-combined-picker-trigger` with a
 * `.seat-change-chip` chrome strip) so fonts, hues, reasoning shimmer, and
 * permission tints stay pixel-identical to the composer — plus the role name
 * right-aligned in the provider accent for same-model panels.
 *
 * Motion contract (mock-approved + owner calls 2026-08-05): every mount shows
 * the BEFORE seat for a 2 s pre-wait, then CharOdometer-rolls every changed
 * run of text to the AFTER seat — replaying on scroll-back/virtualisation
 * remounts is deliberate. A row still inside the coalescing window
 * additionally hops in via the `.is-fresh` mount animation when a coalesced
 * replacement lands. Clicking the row toggles a static "was" line showing the
 * BEFORE seat. Tombstoning (no more in-place updates after the window) is a
 * PERSISTENCE property — see shared/seatChange.ts.
 */

interface SeatSideView {
  provider: string
  hue: string
  providerLabel: string
  modelLabel: string
  reasoningLabel: string
  reasoningToken: string
  presetId: string
  tierLabel: string
  grantsLabel: string
  role: string
  stageRole?: SeatChangeSeatState['stageRole']
  authority?: SeatChangeSeatState['authority']
}

function seatSideView(state: SeatChangeSeatState): SeatSideView {
  const provider = state.provider as ProviderId
  const modelLabel = humaniseModelId(provider, state.model) || state.model
  const reasoningLabel = (
    state.reasoningEffort || state.thinkingEnabled !== undefined
  )
    ? reasoningDisplayLabel({
        provider,
        composerStyle: 'default',
        modelId: state.model,
        modelLabel,
        codexReasoningEffort: state.reasoningEffort,
        claudeReasoningEffort: state.reasoningEffort,
        grokReasoningEffort: state.reasoningEffort,
        cursorReasoningEffort: state.reasoningEffort,
        kimiReasoningEffort: state.reasoningEffort,
        kimiThinkingEnabled: state.thinkingEnabled
      })
    : ''
  // An ABSENT preset is not the default preset. Rows written before the seat
  // snapshot existed carry provider/model/role but no tier, and defaulting
  // there would have the chip claim "Accept Edits" for a lane that may have run
  // read-only — a confident lie about permissions. Unknown renders no chip.
  const presetId = state.permissionPresetId || ''
  const tierLabel = presetId
    ? composerPermissionOptions().find((option) => option.value === presetId)?.label || presetId
    : ''
  const grantsCount = state.grantsCount ?? 0
  return {
    provider: state.provider,
    hue: modelPickerHueClass(provider, state.model, modelLabel),
    providerLabel: resolveProviderBrandLabel(provider, state.model) || getProviderName(provider),
    modelLabel,
    reasoningLabel,
    reasoningToken: state.reasoningEffort || '',
    presetId,
    tierLabel,
    grantsLabel: grantsCount > 0 ? `${grantsCount} grant${grantsCount === 1 ? '' : 's'}` : '',
    role: state.role
      ? state.seatNumber
        ? `#${state.seatNumber} ${state.role}`
        : state.role
      : '',
    // Carried per SIDE so a change that moves a seat between stages, or in or
    // out of authority, is visible in the row — it was previously invisible.
    ...(state.stageRole ? { stageRole: state.stageRole } : {}),
    ...(state.authority ? { authority: state.authority } : {})
  }
}

function formatSeatChangeTime(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Animated text run — a plain function call (not a component) so the
 * CharOdometer keeps its tree position and its previous-text ref across the
 * before→after re-render. A component created inside render would remount
 * every pass and the roll would never fire. */
function seatText(value: string, animate: boolean): JSX.Element | string {
  return animate ? <CharOdometer text={value} /> : value
}

/** The animated seat cluster: [logo] provider · model · reasoning. */
function SeatClusterChip({ view, animate }: { view: SeatSideView; animate: boolean }): JSX.Element {
  return (
    <span
      className="composer-combined-picker-trigger seat-change-chip"
      data-provider={view.provider}
      data-provider-hue={view.hue}
      data-selected-reasoning={view.reasoningToken}
      style={
        { '--chip-accent': `var(--provider-${view.hue}-color, var(--accent))` } as CSSProperties
      }
    >
      <span className="composer-combined-picker-trigger-provider">
        <span className="composer-combined-picker-trigger-provider-icon" aria-hidden>
          <ProviderBrandLogoIcon provider={view.provider as ProviderId} accentProvider={view.hue} />
        </span>
        <span className="composer-combined-picker-trigger-provider-label">
          {seatText(view.providerLabel, animate)}
        </span>
      </span>
      <span className="composer-combined-picker-trigger-primary">
        {seatText(view.modelLabel, animate)}
      </span>
      {view.reasoningLabel && (
        <span className="composer-combined-picker-trigger-tail">
          <span className="composer-combined-picker-trigger-separator" aria-hidden>
            {'\u00A0\u00A0'}
          </span>
          <TriggerReasoningSuffix
            text={view.reasoningLabel}
            sparkle={chipReasoningSparkleTier(view.reasoningToken)}
          >
            {seatText(view.reasoningLabel, animate)}
          </TriggerReasoningSuffix>
        </span>
      )}
    </span>
  )
}

/** The permission chip: tier label + muted grants count, composer tints. */
function SeatPermissionChip({
  view,
  animate
}: {
  view: SeatSideView
  animate: boolean
}): JSX.Element | null {
  // Nothing known and nothing to show: omit the chip rather than render an
  // empty one, which would leave a stray gap in the strip's flex row.
  if (!view.tierLabel && !view.grantsLabel) return null
  return (
    <span
      className="composer-combined-picker-trigger seat-change-chip"
      data-composer-control="permission"
      data-permission-value={view.presetId || undefined}
    >
      {view.tierLabel && (
        <span className="composer-combined-picker-trigger-primary">
          {seatText(view.tierLabel, animate)}
        </span>
      )}
      {view.grantsLabel && (
        <span className="composer-combined-picker-trigger-suffix">
          {seatText(view.grantsLabel, animate)}
        </span>
      )}
    </span>
  )
}

/**
 * The seat strip itself: chair glyph, cluster + permission chips, role. Shared
 * by the transcript row and the round close-out table so both surfaces roll
 * the same element with the same chips — the close-out just renders it inline
 * in a table cell, without the timestamp or the click-to-expand.
 */
function SeatStrip({
  seatChange,
  timestamp,
  inline
}: {
  seatChange: SeatChangePayload | SeatChangeLink
  timestamp?: string
  inline: boolean
}): JSX.Element | null {
  const [phase, setPhase] = useState<'before' | 'after'>('before')

  useEffect(() => {
    if (phase === 'after') return
    // 2 s pre-wait (owner call): the old seat holds long enough to be READ
    // before the odometer rolls it to the new one.
    const timer = window.setTimeout(() => setPhase('after'), 2000)
    return () => window.clearTimeout(timer)
  }, [phase])

  const before = useMemo(() => seatSideView(seatChange.before), [seatChange])
  const after = useMemo(() => seatSideView(seatChange.after), [seatChange])
  const current = phase === 'before' ? before : after
  const time = inline ? '' : formatSeatChangeTime(timestamp)

  const role = current.role ? (
    <span
      className="seat-change-role"
      style={{ color: `var(--provider-${current.hue}-color, var(--accent))` }}
      title={participantRoleIconTitle(current.authority, current.stageRole) || undefined}
    >
      {/* Outside the odometer on purpose: an SVG has no character runs to
          roll, and nesting it would give CharOdometer a slot it cannot
          measure. The glyph swaps instantly while the text rolls. */}
      <ParticipantRoleIcon
        authority={current.authority}
        stageRole={current.stageRole}
        className="seat-change-role-icon"
      />
      <CharOdometer text={current.role} />
    </span>
  ) : null

  return (
    <>
      {/* The chair marks a seat CHANGE. In the close-out table every row is a
          seat, so the glyph says nothing per-row and only costs the left edge
          the #N and role now occupy — dropped there, kept in the transcript
          where it is the row's anchor and its type marker. */}
      {inline ? null : (
        <span className="seat-change-icon" aria-hidden>
          <SeatChairIcon />
        </span>
      )}
      {/* The role LEADS in the close-out table and TRAILS in the transcript,
          and that is not a taste difference. A table is read down its first
          column, so the seat's name has to be the thing the eye lands on — it
          is what one row is ABOUT. A transcript row is read along its length
          and is already anchored by the chair glyph; there the name is the
          answer to "who moved", so it comes after the seat it describes.
          Ordering is DOM order, no flex `order`: the reading order and the
          visual order must not disagree for a screen reader. */}
      {inline ? role : null}
      <SeatClusterChip view={current} animate />
      <SeatPermissionChip view={current} animate />
      {inline ? null : role}
      {time && <span className="seat-change-time">{time}</span>}
    </>
  )
}

/**
 * The colour a seat resolves to — the provider accent, generic accent as
 * fallback. Exported so a host that renders the role in its own heading tints
 * it identically instead of re-deriving the hue and drifting out of step with
 * the chips beside it. (Building the whole view for one field is deliberate:
 * the hue depends on the humanised model label, so deriving it any other way
 * is how the two answers diverge.)
 */
export function seatAccentVar(seat: SeatChangeSeatState): string {
  return `var(--provider-${seatSideView(seat).hue}-color, var(--accent))`
}

/**
 * A seat rendered as a STATE rather than a change — the two composer chips and
 * nothing else.
 *
 * Deliberately missing three things the change variants carry. No chair glyph:
 * that glyph *claims* a seat was reconfigured, and asserting it where nothing
 * changed is a lie the reader has been trained to believe. No roll: there is no
 * before to roll from, and the odometer's per-character measured slots are pure
 * cost when every slot is static. No role: a host showing one state generally
 * wants the role in its own heading (see `seatAccentVar` for tinting it), which
 * is exactly what the peer thread-message card does — it answers "who sent
 * this", not "what changed".
 */
export function SeatStateChips({
  seat,
  className
}: {
  seat: SeatChangeSeatState
  className?: string
}): JSX.Element {
  const view = useMemo(() => seatSideView(seat), [seat])
  return (
    <span className={`seat-state-chips${className ? ' ' + className : ''}`}>
      <SeatClusterChip view={view} animate={false} />
      <SeatPermissionChip view={view} animate={false} />
    </span>
  )
}

/**
 * Close-out variant: the same strip, inline in a markdown table cell. No
 * timestamp (the close-out header carries the time), no click-to-expand, and
 * no button — a table cell's seat is a RECORD, and the roll replaying every
 * time the row scrolls back into view is how the before state is shown.
 * Spans throughout, so it is valid inside a `<td>` with no block wrapper.
 */
export function SeatChangeInlineStrip({ link }: { link: SeatChangeLink }): JSX.Element {
  return (
    <span className="seat-change-message is-inline">
      <span className="seat-change-row">
        <SeatStrip seatChange={link} inline />
      </span>
    </span>
  )
}

export function SeatChangeRow({ message }: { message: ChatMessage }): JSX.Element | null {
  const seatChange = message.metadata?.seatChange
  // Fresh = still inside the coalescing window at MOUNT — gates only the HOP
  // (the coalesced-row reposition animation). The before->after ROLL replays
  // on every mount, by owner call 2026-08-05: the row is a record of a
  // change, and replaying it on encounter (scroll-back, virtualisation
  // remounts included) is the feature.
  const [fresh] = useState(() =>
    Boolean(
      seatChange &&
        Date.now() - Date.parse(seatChange.appliedAt || '') < SEAT_CHANGE_COALESCE_WINDOW_MS
    )
  )
  const [expanded, setExpanded] = useState(false)
  const before = useMemo(() => (seatChange ? seatSideView(seatChange.before) : null), [seatChange])
  if (!seatChange || !before) return null

  return (
    <div
      className={`message-group seat-change-message${fresh ? ' is-fresh' : ''}${
        expanded ? ' is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="seat-change-row"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={
          expanded ? 'Hide the previous seat configuration' : 'Show the previous seat configuration'
        }
      >
        <SeatStrip seatChange={seatChange} timestamp={message.timestamp} inline={false} />
      </button>
      {expanded && (
        <div className="seat-change-was">
          <span className="seat-change-was-label">was</span>
          <SeatClusterChip view={before} animate={false} />
          <SeatPermissionChip view={before} animate={false} />
          {before.role && (
            <span
              className="seat-change-role"
              style={{ color: `var(--provider-${before.hue}-color, var(--accent))` }}
              title={participantRoleIconTitle(before.authority, before.stageRole) || undefined}
            >
              <ParticipantRoleIcon
                authority={before.authority}
                stageRole={before.stageRole}
                className="seat-change-role-icon"
              />
              {before.role}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
