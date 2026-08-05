import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage, ProviderId, SeatChangeSeatState } from '../../../main/store/types'
import {
  TriggerReasoningSuffix,
  chipReasoningSparkleTier,
  modelPickerHueClass
} from './CombinedModelPicker'
import { CharOdometer } from './CharOdometer'
import { SeatChairIcon } from './icons/SeatChairIcon'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { getProviderName } from './Sidebar'
import { resolveProviderBrandLabel } from '../lib/ollamaDisplayBrand'
import { humaniseModelId } from '../lib/modelDisplayName'
import { reasoningDisplayLabel } from '../lib/composerChipFormat'
import { composerPermissionOptions } from '../lib/planModeLabels'
import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'

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
}

function seatSideView(state: SeatChangeSeatState): SeatSideView {
  const provider = state.provider as ProviderId
  const modelLabel = humaniseModelId(provider, state.model) || state.model
  const reasoningLabel = state.reasoningEffort
    ? reasoningDisplayLabel({
        provider,
        composerStyle: 'default',
        modelId: state.model,
        modelLabel,
        codexReasoningEffort: state.reasoningEffort,
        claudeReasoningEffort: state.reasoningEffort,
        grokReasoningEffort: state.reasoningEffort,
        cursorReasoningEffort: state.reasoningEffort,
        kimiReasoningEffort: state.reasoningEffort
      })
    : ''
  const presetId = state.permissionPresetId || 'default'
  const tierLabel =
    composerPermissionOptions().find((option) => option.value === presetId)?.label || presetId
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
      : ''
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
}): JSX.Element {
  return (
    <span
      className="composer-combined-picker-trigger seat-change-chip"
      data-composer-control="permission"
      data-permission-value={view.presetId}
    >
      <span className="composer-combined-picker-trigger-primary">
        {seatText(view.tierLabel, animate)}
      </span>
      {view.grantsLabel && (
        <span className="composer-combined-picker-trigger-suffix">
          {seatText(view.grantsLabel, animate)}
        </span>
      )}
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
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (phase === 'after') return
    // 2 s pre-wait (owner call): the old seat holds long enough to be READ
    // before the odometer rolls it to the new one.
    const timer = window.setTimeout(() => setPhase('after'), 2000)
    return () => window.clearTimeout(timer)
  }, [phase])

  const before = useMemo(() => (seatChange ? seatSideView(seatChange.before) : null), [seatChange])
  const after = useMemo(() => (seatChange ? seatSideView(seatChange.after) : null), [seatChange])
  if (!seatChange || !before || !after) return null

  const current = phase === 'before' ? before : after
  const time = formatSeatChangeTime(message.timestamp)

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
        <span className="seat-change-icon" aria-hidden>
          <SeatChairIcon />
        </span>
        <SeatClusterChip view={current} animate />
        <SeatPermissionChip view={current} animate />
        {current.role && (
          <span
            className="seat-change-role"
            style={{ color: `var(--provider-${current.hue}-color, var(--accent))` }}
          >
            <CharOdometer text={current.role} />
          </span>
        )}
        {time && <span className="seat-change-time">{time}</span>}
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
            >
              {before.role}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
