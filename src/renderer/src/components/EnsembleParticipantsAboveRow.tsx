/*
 * EnsembleParticipantsAboveRow — 1.0.3 ship-night.
 *
 * Replaces the bottom-pinned `EnsembleSetupSheet` modal AND the
 * top-of-chat `EnsembleParticipantStrip`, consolidating both into a
 * single composer above-row that sits below the existing file-changes
 * + Create PR row and above the composer textarea.
 *
 * Slice F v2 (1.0.3 — same ship-night rework): instead of opening a
 * per-chip flyout for editing, clicking a chip SELECTS it. The
 * composer's existing `CombinedModelPicker` + `CombinedPermissionsPicker`
 * then rebind to read/write the selected participant's settings. This
 * means there's one set of pickers in the app (the composer's), and
 * the chips just retarget who they configure.
 *
 *   - Click chip → onSelectParticipant(id). The chip gets a thick
 *     accent border to signal selection.
 *   - Drag horizontally → reorder the speaking sequence (HTML5
 *     native drag-and-drop, persisted via onChatChange).
 *   - On the selected chip only, a `⋯` overflow button surfaces an
 *     inline mini-popover for the two affordances that don't have
 *     a natural home in the composer pickers: `enabled` toggle and
 *     `role` rename.
 *   - Disabled participants render dimmed; they're still selectable
 *     so the user can re-enable from the overflow.
 *
 * Selection state lives in the parent (App.tsx) so the composer
 * pickers can read it. Auto-follow-active-speaker logic also lives
 * upstream — this component is otherwise display-only beyond click +
 * drag + the overflow editor.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ChatRecord,
  ComposerStyle,
  ConcurrentLane,
  EnsembleParticipant,
  ProviderId
} from '../../../main/store/types'
import { getDefaultEnsembleParticipantConfig } from '../lib/ensembleProviderDefaults'
import {
  ENSEMBLE_ROLE_PRESET_CUSTOM,
  ENSEMBLE_ROLE_PRESETS,
  resolveRolePresetId,
  roleLabelForPresetId
} from '../lib/ensembleRolePresets'
import { buildParticipantTokenChipModel } from '../lib/participantTokenChip'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { withSessionActivityLedger } from '../lib/sessionActivityLedger'
import { isEnsembleActiveRoundDispatchLive } from '../lib/chatBusyState'
import {
  ComposerProviderPickerRows,
  resolveProviderRows
} from './ComposerProviderPicker'
import { getProviderName } from './Sidebar'

// 1.0.4-AR2 — global ceiling raised from 6 → 8 so the panel can host
// the broader four-provider roster plus alternates (e.g. two Claudes
// in different roles). The hard minimum is enforced in
// `removeParticipant` below at `<= 2` so a panel is never reduced to
// a solo speaker — keeps the ensemble distinct from a single-provider
// chat throughout its lifecycle.
//
// 1.0.5-EW1 — Ceiling raised again 8 → 12. The chip strip now wraps
// to a second row at 7+ participants (see CSS: .is-wrapped → grid
// with 6 equal-width columns) instead of overflowing horizontally,
// so the strip stays navigable up to the new cap. Agents can
// sub-delegate via delegate_to_subthread for fanouts wider than the
// panel — 12 named peers is plenty even for heavy collaborative
// tasks.
const MAX_ENSEMBLE_PARTICIPANTS = 12
const MIN_ENSEMBLE_PARTICIPANTS = 2
// 1.0.5-EW1 — Threshold at which the chip strip switches from the
// centered horizontal flex layout to a 6-column grid that wraps to
// a second row. 7 = "more chips than fit cleanly on one row at
// readable size".
const ENSEMBLE_CHIPS_WRAP_THRESHOLD = 7

function laneStatusToParticipantLabel(status: ConcurrentLane['status']): string {
  switch (status) {
    case 'pending':
      return 'idle'
    case 'running':
      return 'speaking'
    case 'completed':
      return 'answered'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
      return 'failed'
    case 'awaiting-approval':
      return 'running'
    default:
      return 'idle'
  }
}

function latestLaneForParticipant(
  lanes: Record<string, ConcurrentLane> | undefined,
  participantId: string
): ConcurrentLane | undefined {
  const matches = Object.values(lanes || {}).filter((lane) => lane.participantId === participantId)
  return (
    matches.find(
      (lane) =>
        lane.status === 'running' ||
        lane.status === 'pending' ||
        lane.status === 'awaiting-approval' ||
        lane.status === 'blocked'
    ) || matches[matches.length - 1]
  )
}

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
function ParticipantStatusIcon({ status }: { status: string }): React.JSX.Element {
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

function BossmanCrownIcon({ className }: { className?: string }): React.JSX.Element {
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

interface EnsembleParticipantsAboveRowProps {
  chat: ChatRecord
  selectedParticipantId: string | null
  onSelectParticipant: (id: string) => void
  onChatChange: (next: ChatRecord) => void
  /**
   * "Skip" the currently-speaking participant. Cancels the active
   * provider run and lets the orchestrator's round-loop advance to
   * the next participant without restarting the round. The composer's
   * existing Stop button (wired to `handleCancel` → `cancelEnsembleRound`)
   * handles full-round cancellation, so the chip strip's previous
   * "Stop Ensemble" button was redundant and got dropped in favour of
   * this gentler Skip affordance.
   */
  onSkipActive?: () => void
  /**
   * 1.0.4-AK2 — Stop the active Work Session. Cancels the in-flight
   * round + clears queued continuations + flips
   * `workSession.status` to `'cancelled'`. Wired to
   * `handleStopWorkSession` in App.tsx; omitted in non-Work-Session
   * surfaces (e.g. older harness tests) so the strip degrades to
   * disabled.
   */
  onStopWorkSession?: () => void
  /**
   * 1.0.4-AT7 — re-dispatch a single participant whose last turn
   * failed/timed-out/was unreachable. The caller decides how to
   * source the retry prompt (typically the chat's last user
   * prompt) and what dispatch path to use (e.g. DM via
   * `runEnsembleRound({ dmTargetParticipantId })`). When omitted,
   * the overflow popover hides the Retry row.
   */
  onRetryParticipant?: (participantId: string) => void
  /**
   * 1.0.5-N7 — User-initiated Wake-Now from the chip overflow. Fires
   * the wakeup immediately via the orchestrator's handleWakeupFired
   * (same code path as the timer firing naturally). Omitted in
   * harness tests that don't model wakeups.
   */
  onWakeNowParticipant?: (wakeupId: string) => void
  /**
   * 1.0.5-N7 — User-initiated Cancel of a pending wakeup. Marks
   * the persisted record cancelled and flips the participant out
   * of the sleeping state.
   */
  onCancelWakeupParticipant?: (wakeupId: string) => void
  /** Shell token for the portaled add-participant provider picker. */
  composerStyle?: ComposerStyle
  grokAvailable?: boolean
  cursorAvailable?: boolean
  /** Slide the row up from behind the composer on mount (workflow Run-as-ensemble
   *  toggle) — scoped so the row doesn't animate on every ensemble chat. */
  animateEntrance?: boolean
}

interface ChipDragGhostState {
  participantId: string
  x: number
  y: number
  width: number
  offsetX: number
  offsetY: number
}

interface ChipDragStartInfo {
  pointerX: number
  pointerY: number
  chipRect: DOMRect
  offsetX: number
  offsetY: number
}

function resolveReorderDropTarget(
  container: HTMLElement | null,
  x: number,
  y: number,
  sourceId: string
): string | null {
  if (!container) return null

  const chips = Array.from(
    container.querySelectorAll('.ensemble-above-chip[data-participant-id]:not(.is-dragging)')
  ) as HTMLElement[]

  const directTarget = document.elementFromPoint(x, y) as HTMLElement | null
  const directChip = directTarget?.closest(
    '.ensemble-above-chip[data-participant-id]:not(.is-dragging)'
  ) as HTMLElement | null
  const directId = directChip?.getAttribute('data-participant-id')
  if (directId && directId !== sourceId) {
    return directId
  }

  const containerRect = container.getBoundingClientRect()
  const verticalTolerance = 56
  if (
    y < containerRect.top - verticalTolerance ||
    y > containerRect.bottom + verticalTolerance ||
    x < containerRect.left - 80 ||
    x > containerRect.right + 80
  ) {
    return null
  }

  let nearestId: string | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const chip of chips) {
    const id = chip.getAttribute('data-participant-id')
    if (!id || id === sourceId) continue
    const rect = chip.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const distance = Math.hypot(x - centerX, y - centerY)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestId = id
    }
  }
  return nearestId
}

function escapeSelectorAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

export function resolveParticipantSelectionAfterRemoval(
  participants: EnsembleParticipant[],
  removedId: string,
  selectedParticipantId: string | null
): string | null {
  if (selectedParticipantId !== removedId) return selectedParticipantId
  const removedIndex = participants.findIndex((participant) => participant.id === removedId)
  if (removedIndex === -1) return null
  return participants[removedIndex - 1]?.id ?? participants[removedIndex + 1]?.id ?? null
}

export function EnsembleParticipantsAboveRow({
  chat,
  selectedParticipantId,
  onSelectParticipant,
  onChatChange,
  onSkipActive,
  onStopWorkSession,
  onRetryParticipant,
  onWakeNowParticipant,
  onCancelWakeupParticipant,
  composerStyle = 'default',
  grokAvailable = false,
  cursorAvailable = false,
  animateEntrance = false
}: EnsembleParticipantsAboveRowProps): React.JSX.Element | null {
  const chipsContainerRef = useRef<HTMLDivElement | null>(null)
  const pendingFocusParticipantIdRef = useRef<string | null>(null)
  const [overflowOpenId, setOverflowOpenId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragGhost, setDragGhost] = useState<ChipDragGhostState | null>(null)
  const [workSessionNow, setWorkSessionNow] = useState(() => Date.now())

  const participants =
    chat.chatKind === 'ensemble' && chat.ensemble
      ? [...(chat.ensemble.participants || [])].sort((a, b) => a.order - b.order)
      : []
  const participantIdsKey = participants.map((participant) => participant.id).join('\u001f')
  const workSession = chat.chatKind === 'ensemble' ? chat.ensemble?.workSession : undefined
  const workSessionStatus = workSession?.status
  // Live = the session is still consuming its duration budget. Only
  // then does a "… left" countdown make sense; ended sessions show
  // elapsed time + their ended reason instead of a stale "0s left".
  const isWorkSessionLive = workSessionStatus === 'active' || workSessionStatus === 'paused'
  const showWorkSessionStrip =
    workSession?.enabled &&
    (workSessionStatus === 'active' ||
      workSessionStatus === 'paused' ||
      workSessionStatus === 'completed' ||
      workSessionStatus === 'cancelled' ||
      workSessionStatus === 'limit_reached')

  useEffect(() => {
    if (!showWorkSessionStrip) return
    const handle = window.setInterval(() => setWorkSessionNow(Date.now()), 30_000)
    return () => window.clearInterval(handle)
  }, [showWorkSessionStrip, workSession?.startedAt, workSession?.maxDurationMs])

  useEffect(() => {
    const pendingParticipantId = pendingFocusParticipantIdRef.current
    if (!pendingParticipantId || selectedParticipantId !== pendingParticipantId) return
    pendingFocusParticipantIdRef.current = null
    const selector = `[data-participant-id="${escapeSelectorAttributeValue(pendingParticipantId)}"] .ensemble-above-chip-body`
    const focusTarget = chipsContainerRef.current?.querySelector<HTMLElement>(selector)
    focusTarget?.focus({ preventScroll: true })
  }, [participantIdsKey, selectedParticipantId])

  if (chat.chatKind !== 'ensemble' || !chat.ensemble) return null

  const activeRound = chat.ensemble.activeRound
  const isRoundRunning = isEnsembleActiveRoundDispatchLive(activeRound)
  const canAddParticipant = !isRoundRunning && participants.length < MAX_ENSEMBLE_PARTICIPANTS

  const updateParticipant = (id: string, patch: Partial<EnsembleParticipant>): void => {
    if (isRoundRunning) return
    const next = participants.map((p) => (p.id === id ? { ...p, ...patch } : p))
    persist(next)
  }

  const patchEnsemble = (
    patch: Partial<NonNullable<ChatRecord['ensemble']>>,
    source: ChatRecord = chat
  ): void => {
    if (source.chatKind !== 'ensemble' || !source.ensemble) return
    const nextChat: ChatRecord = {
      ...source,
      ensemble: {
        ...source.ensemble,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    }
    onChatChange(withSessionActivityLedger(source, nextChat))
  }

  const setBossmanParticipant = (participantId: string | undefined): void => {
    if (isRoundRunning) return
    const nextBossmanParticipantId =
      participantId && participants.some((participant) => participant.id === participantId)
        ? participantId
        : undefined
    patchEnsemble({
      bossmanParticipantId: nextBossmanParticipantId,
      bossmanAutoApprovals:
        nextBossmanParticipantId &&
        nextBossmanParticipantId === chat.ensemble?.bossmanParticipantId
          ? chat.ensemble.bossmanAutoApprovals
          : undefined
    })
  }

  const setBossmanAutoApprovals = (enabled: boolean): void => {
    if (isRoundRunning || !chat.ensemble?.bossmanParticipantId) return
    if (enabled) {
      const confirmed = window.confirm(
        'Allow Boss Auto Approvals for this Ensemble? Boss can only resolve one-shot approvals within the selected participant permission preset and workspace policy. This will not grant session/workspace approval, YOLO, policy changes, external-path escapes, or unclassified requests.'
      )
      if (!confirmed) return
    }
    patchEnsemble({
      bossmanAutoApprovals: enabled
        ? {
            enabled: true,
            mode: 'permission_preset_once',
            confirmedAt: new Date().toISOString()
          }
        : undefined
    })
  }

  const persist = (nextParticipants: EnsembleParticipant[]): void => {
    // 1.0.4-AR2 — preserve any existing per-chat `maxParticipants`
    // override that's already in range [MIN, MAX]. Pre-AR2 every
    // persist clobbered the cap to the global ceiling, silently
    // expanding a user's deliberately-tightened 3-of-N panel back
    // to the default whenever they toggled a participant. Fall back
    // to the ceiling only when the stored value is missing /
    // nonsensical / out of range.
    //
    // 1.0.5-EW5 — Bump the stored cap up to at least the current
    // participant count. Pre-EW5 a chat created on the 8-cap build
    // (or 6-cap pre-AR2) kept its stale stored cap forever even
    // after the user added participants past that cap via the
    // chip strip (the chip strip's add button uses the GLOBAL
    // MAX_ENSEMBLE_PARTICIPANTS, not the chat's stored max). The
    // chat ended up with participants.length=12 and
    // maxParticipants=6 — the chip strip showed all 12 but the
    // prompt builder's slice cut at 6, so participants 7-12
    // silently never spoke and never ran the pre-flight health
    // probe. Ratchet the stored cap up here so the two stay in
    // sync; we only ever GROW, never shrink, so a user's
    // deliberately-tightened panel still survives normal toggles.
    const existingMax = chat.ensemble?.maxParticipants
    const preservedMax =
      Number.isFinite(existingMax) &&
      (existingMax as number) >= MIN_ENSEMBLE_PARTICIPANTS &&
      (existingMax as number) <= MAX_ENSEMBLE_PARTICIPANTS
        ? (existingMax as number)
        : MAX_ENSEMBLE_PARTICIPANTS
    const clampedMax = Math.min(
      MAX_ENSEMBLE_PARTICIPANTS,
      Math.max(preservedMax, nextParticipants.length)
    )
    const existingBossmanParticipantId = chat.ensemble?.bossmanParticipantId
    const bossmanParticipantId =
      existingBossmanParticipantId &&
      nextParticipants.some((participant) => participant.id === existingBossmanParticipantId)
        ? existingBossmanParticipantId
        : undefined
    const nextChat: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble!,
        maxParticipants: clampedMax,
        participants: nextParticipants.map((p, idx) => ({ ...p, order: idx + 1 })),
        bossmanParticipantId,
        bossmanAutoApprovals: bossmanParticipantId
          ? chat.ensemble?.bossmanAutoApprovals
          : undefined,
        updatedAt: new Date().toISOString()
      }
    }
    onChatChange(withSessionActivityLedger(chat, nextChat))
  }

  const addParticipant = (chosenProvider?: ProviderId): void => {
    if (!canAddParticipant) return
    const source =
      participants.find((participant) => participant.id === selectedParticipantId) ||
      participants[participants.length - 1]
    const provider: ProviderId = chosenProvider || source?.provider || 'codex'
    const defaults = getDefaultEnsembleParticipantConfig(provider)
    const sourceIndex = source
      ? participants.findIndex((participant) => participant.id === source.id)
      : participants.length - 1
    const newParticipant: EnsembleParticipant = {
      id: nextParticipantId(participants),
      provider,
      enabled: true,
      role: nextRoleLabel(source?.role || getProviderName(provider), participants),
      instructions:
        source?.instructions || `Contribute as ${getProviderName(provider)} for this ensemble.`,
      order: participants.length + 1,
      model: source?.model || defaults.model,
      runtimeProfileId: source?.runtimeProfileId,
      geminiAuthProfileId: provider === 'gemini' ? source?.geminiAuthProfileId || null : null,
      permissionPresetId: source?.permissionPresetId || defaults.permissionPresetId,
      reasoningEffort: source?.reasoningEffort || defaults.reasoningEffort,
      fastModeEnabled: source?.fastModeEnabled ?? defaults.fastModeEnabled,
      thinkingEnabled: source?.thinkingEnabled ?? defaults.thinkingEnabled,
      serviceTier: source?.serviceTier ?? defaults.serviceTier
    }
    const next = [...participants]
    next.splice(Math.max(0, sourceIndex + 1), 0, newParticipant)
    persist(next)
    onSelectParticipant(newParticipant.id)
  }

  const removeParticipant = (id: string): void => {
    // 1.0.4-AR2 — hard floor of 2 participants. Pre-AR2 this was
    // `<= 1` (i.e. you could always have a solo ensemble), which
    // defeats the point of the ensemble surface. The chip strip
    // already renders the trash button disabled when at the floor;
    // this guard is the defense-in-depth for IPC-driven roster edits.
    if (isRoundRunning || participants.length <= MIN_ENSEMBLE_PARTICIPANTS) return
    const nextSelectedParticipantId = resolveParticipantSelectionAfterRemoval(
      participants,
      id,
      selectedParticipantId
    )
    const next = participants.filter((participant) => participant.id !== id)
    persist(next)
    if (selectedParticipantId === id && nextSelectedParticipantId) {
      pendingFocusParticipantIdRef.current = nextSelectedParticipantId
      onSelectParticipant(nextSelectedParticipantId)
    }
    if (overflowOpenId === id) {
      setOverflowOpenId(null)
    }
  }

  const handleReorder = (sourceId: string, targetId: string | null): void => {
    setDragId(null)
    setDragOverId(null)
    setDragGhost(null)
    if (isRoundRunning) return
    if (!targetId || sourceId === targetId) return
    const fromIdx = participants.findIndex((p) => p.id === sourceId)
    const toIdx = participants.findIndex((p) => p.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...participants]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    persist(next)
  }

  // 1.0.4-AK2 — Work Session status strip. Renders ABOVE the chip
  // strip when a Work Session exists in any non-idle state so the
  // user always knows the round is running autonomously vs.
  // interactively. The strip surfaces the objective, current
  // budget consumption, elapsed/remaining time, and a Stop action.
  // Below-budget hops + statuses fall through with muted styling.
  // Elapsed / remaining time computed from startedAt + maxDurationMs.
  // Cached on the render to avoid jitter; the parent re-renders
  // every 30s while the strip is visible (cheap interval).
  const workSessionTime = (() => {
    if (!workSession?.startedAt) return null
    const started = new Date(workSession.startedAt).getTime()
    if (!Number.isFinite(started)) return null
    // For an ended session, freeze elapsed at the actual run duration
    // (startedAt → endedAt) instead of letting it keep ticking up with
    // the live clock. Live sessions measure against `now`.
    const endedAt =
      !isWorkSessionLive && workSession.endedAt ? new Date(workSession.endedAt).getTime() : NaN
    const endpoint = Number.isFinite(endedAt) ? endedAt : workSessionNow
    const elapsedMs = Math.max(0, endpoint - started)
    const remainingMs = Math.max(0, (workSession.maxDurationMs || 0) - elapsedMs)
    return { elapsedMs, remainingMs }
  })()

  const formatDuration = (ms: number): string => {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remMinutes = minutes % 60
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
  }

  // Per-provider budget summary — picks the provider with the
  // highest usage so the strip shows the participant closest to
  // its cap. "Codex 8/38" reads more usefully than a sum.
  const workSessionBudget = (() => {
    if (!workSession) return null
    const entries = Object.entries(workSession.roundsUsed || {}).filter(
      ([, used]) => (used || 0) > 0
    )
    if (entries.length === 0) {
      return `0 / ${workSession.maxRoundsPerProvider}`
    }
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0))
    const [provider, used] = entries[0]
    return `${used} / ${workSession.maxRoundsPerProvider} (${provider})`
  })()

  const workSessionStatusLabel = (() => {
    switch (workSessionStatus) {
      case 'active':
        return '🎯 Working on'
      case 'paused':
        return '⏸ Paused'
      case 'completed':
        return '✓ Completed'
      case 'cancelled':
        return '✕ Stopped'
      case 'limit_reached':
        return '⏱ Limit reached'
      default:
        return '🎯 Work Session'
    }
  })()

  return (
    <div
      className={`ensemble-above-row${animateEntrance ? ' ensemble-above-row-entering' : ''}`}
      role="region"
      aria-label="Ensemble participants"
    >
      {showWorkSessionStrip && workSession && (
        <div
          className="work-session-strip"
          data-status={workSessionStatus}
          role="status"
          aria-live="polite"
        >
          <span className="work-session-strip-glyph" aria-hidden="true" />
          <span className="work-session-strip-objective" title={workSession.objective}>
            <strong>{workSessionStatusLabel}:</strong> {workSession.objective}
          </span>
          <span className="work-session-strip-meta">
            <span>Rounds {workSessionBudget}</span>
            {workSessionTime && (
              <span>
                {formatDuration(workSessionTime.elapsedMs)} elapsed
                {isWorkSessionLive && <> · {formatDuration(workSessionTime.remainingMs)} left</>}
              </span>
            )}
          </span>
          {workSessionStatus === 'active' || workSessionStatus === 'paused' ? (
            <span className="work-session-strip-actions">
              <button
                type="button"
                className="work-session-strip-action work-session-strip-action--stop"
                onClick={() => onStopWorkSession?.()}
                disabled={!onStopWorkSession}
                title="Stop the Work Session and cancel any queued continuations."
              >
                Stop
              </button>
            </span>
          ) : (
            workSession.endedReason && (
              <span className="work-session-strip-meta" title={workSession.endedReason}>
                <em>{workSession.endedReason}</em>
              </span>
            )
          )}
        </div>
      )}
      <div
        ref={chipsContainerRef}
        className={`ensemble-above-row-chips ${
          // 1.0.5-EW1 — Switch to the wrapping grid layout at 7+
          // participants so the strip never clips. Below the
          // threshold we keep the centred horizontal flex layout —
          // most ensembles live there.
          participants.length >= ENSEMBLE_CHIPS_WRAP_THRESHOLD ? 'is-wrapped' : ''
        } ${dragGhost ? 'is-chip-dragging' : ''}`}
        data-participant-count={participants.length}
      >
        {participants.map((participant) => {
          const state = activeRound?.participants.find(
            (item) => item.participantId === participant.id
          )
          const lane = latestLaneForParticipant(activeRound?.lanes, participant.id)
          const laneStatusLabel = lane ? laneStatusToParticipantLabel(lane.status) : null
          const active =
            activeRound?.activeParticipantId === participant.id ||
            lane?.status === 'running' ||
            lane?.status === 'awaiting-approval'
          const statusLabel = laneStatusLabel || (active ? 'speaking' : state?.status || 'idle')
          const isSelected = participant.id === selectedParticipantId
          // 1.0.4-AD — surface the pre-flight probe's failure reason
          // (or any subsequent failure reason stamped on the round
          // state) so the chip's status pill tooltip explains WHY a
          // participant is unreachable / failed without diving into
          // the transcript. Empty string when the round state has no
          // failure metadata so the chip falls back to the bare
          // status label.
          const statusTooltip =
            lane?.reason ||
            state?.lastFailureReason ||
            (state?.status === 'failed' ? state?.reason : '') ||
            ''
          const wakeupTooltip = state?.status === 'sleeping' ? state.reason || '' : ''
          // 1.0.4-AT7 — retryable when the participant's last turn
          // exited in a failure state. The Retry row in the overflow
          // popover re-dispatches the chat's last user prompt as a
          // DM to this participant via the AT4-extended
          // `runEnsembleRound` IPC path. Active and idle participants
          // don't get a Retry row (active = currently speaking, idle
          // = ready to go on next dispatch).
          const isRetryable =
            !active &&
            (state?.status === 'failed' || state?.status === 'unreachable') &&
            !isRoundRunning
          // 1.0.5-N7 — Look up this participant's pending wakeup (if
          // any) from the chat's persisted wakeups map. The
          // sleeping chip shows Wake-Now + Cancel rows in the
          // overflow popover. We rely on the persisted record
          // because in-memory runtime state isn't visible to the
          // renderer.
          const pendingWakeup = activeRound
            ? Object.values(chat.ensemble?.wakeups || {}).find(
                (wakeup) =>
                  wakeup.status === 'pending' &&
                  wakeup.roundId === activeRound.roundId &&
                  wakeup.participantId === participant.id
              )
            : undefined
          return (
            <ParticipantChip
              key={participant.id}
              participant={participant}
              statusLabel={statusLabel}
              statusTooltip={wakeupTooltip || statusTooltip}
              dimmed={!participant.enabled}
              isSelected={isSelected}
              isDragOver={dragOverId === participant.id && dragId !== participant.id}
              isDragging={dragId === participant.id}
              overflowOpen={overflowOpenId === participant.id}
              onClick={() => {
                // 1.0.5-EW22 — Second-click-on-selected opens the
                // popover (replacing the ⋯ overflow button that
                // used to live inline on the chip and overlapped
                // into the next chip). First click selects.
                // Click outside the chip + popover dismisses
                // (handled by OverflowPopover's outside-click).
                if (participant.id === selectedParticipantId) {
                  setOverflowOpenId((curr) => (curr === participant.id ? null : participant.id))
                } else {
                  onSelectParticipant(participant.id)
                  if (overflowOpenId && overflowOpenId !== participant.id) {
                    setOverflowOpenId(null)
                  }
                }
              }}
              onCloseOverflow={() => setOverflowOpenId(null)}
              onPatch={(patch) => updateParticipant(participant.id, patch)}
              isBossman={chat.ensemble?.bossmanParticipantId === participant.id}
              autoApprovalsEnabled={
                chat.ensemble?.bossmanParticipantId === participant.id &&
                chat.ensemble?.bossmanAutoApprovals?.enabled === true
              }
              onSetBossman={setBossmanParticipant}
              onToggleBossmanAutoApprovals={setBossmanAutoApprovals}
              locked={isRoundRunning}
              onDragStart={(info) => {
                setDragId(participant.id)
                setDragGhost({
                  participantId: participant.id,
                  x: info.pointerX - info.offsetX,
                  y: info.pointerY - info.offsetY,
                  width: info.chipRect.width,
                  offsetX: info.offsetX,
                  offsetY: info.offsetY
                })
              }}
              onDragMove={(pointerX, pointerY) => {
                setDragGhost((current) =>
                  current
                    ? {
                        ...current,
                        x: pointerX - current.offsetX,
                        y: pointerY - current.offsetY
                      }
                    : null
                )
                const overId = resolveReorderDropTarget(
                  chipsContainerRef.current,
                  pointerX,
                  pointerY,
                  participant.id
                )
                setDragOverId(overId)
              }}
              onDragEnd={(pointerX, pointerY) => {
                const droppedOnId = resolveReorderDropTarget(
                  chipsContainerRef.current,
                  pointerX,
                  pointerY,
                  participant.id
                )
                handleReorder(participant.id, droppedOnId)
              }}
              onRetry={
                isRetryable && onRetryParticipant
                  ? () => onRetryParticipant(participant.id)
                  : undefined
              }
              onWakeNow={
                pendingWakeup && onWakeNowParticipant
                  ? () => onWakeNowParticipant(pendingWakeup.wakeupId)
                  : undefined
              }
              onCancelWakeup={
                pendingWakeup && onCancelWakeupParticipant
                  ? () => onCancelWakeupParticipant(pendingWakeup.wakeupId)
                  : undefined
              }
              wakeAt={pendingWakeup?.wakeAt}
            />
          )
        })}
      </div>
      {/*
        1.0.5-EW2 — The "+ add participant" button lives OUTSIDE
        the chip strip / grid. Pre-EW2 the button was inside
        `.ensemble-above-row-chips`, which took a grid cell in the
        wrapped layout and forced a third row at 12 participants
        (6 + 6 chips + 1 standalone "+" cell). Sibling placement
        + flex layout on the parent `.ensemble-above-row` pins
        the button to the right edge of the row at all counts,
        matching the existing `.ensemble-above-row-actions`
        right-justified pattern. At low counts (1-6) the button
        sits at the far-right while chips stay centred in their
        flex slot — same visual logic as Stop Ensemble + queued-
        prompt indicator.
      */}
      <EnsembleAddParticipantButton
        disabled={!canAddParticipant}
        title={
          isRoundRunning
            ? 'Participant changes are locked while a round is running.'
            : participants.length >= MAX_ENSEMBLE_PARTICIPANTS
              ? `Ensembles support up to ${MAX_ENSEMBLE_PARTICIPANTS} participants.`
              : 'Add another participant'
        }
        composerStyle={composerStyle}
        grokAvailable={grokAvailable}
        cursorAvailable={cursorAvailable}
        onAdd={addParticipant}
      />
      {dragGhost
        ? (() => {
            const ghostParticipant = participants.find(
              (participant) => participant.id === dragGhost.participantId
            )
            if (!ghostParticipant) return null
            return createPortal(
              <div
                className={`ensemble-above-chip ensemble-above-chip-drag-ghost provider-${resolveProviderHueClass(ghostParticipant.provider, ghostParticipant.model)} is-selected`}
                style={{
                  position: 'fixed',
                  left: `${dragGhost.x}px`,
                  top: `${dragGhost.y}px`,
                  width: `${dragGhost.width}px`,
                  zIndex: 10050
                }}
                aria-hidden
              >
                <div className="ensemble-above-chip-body">
                  <span className="ensemble-above-chip-role">
                    {ghostParticipant.role || getProviderName(ghostParticipant.provider)}
                  </span>
                </div>
              </div>,
              document.body
            )
          })()
        : null}
      {/*
        1.0.5-EW22 — "-" remove-selected sibling button. Pairs with
        "+" on the right edge so the roster's add/remove controls
        live in one visual locus, freeing the popover from
        carrying a destructive row. Disabled when no chip is
        selected, when at the 2-participant floor, or when a round
        is running (matches `removeParticipant`'s own guards).
      */}
      <button
        type="button"
        className="ensemble-above-remove-participant"
        onClick={() => {
          if (selectedParticipantId) removeParticipant(selectedParticipantId)
        }}
        disabled={
          isRoundRunning ||
          !selectedParticipantId ||
          participants.length <= MIN_ENSEMBLE_PARTICIPANTS
        }
        title={
          isRoundRunning
            ? 'Participant changes are locked while a round is running.'
            : !selectedParticipantId
              ? 'Select a participant chip first.'
              : participants.length <= MIN_ENSEMBLE_PARTICIPANTS
                ? `Ensembles require at least ${MIN_ENSEMBLE_PARTICIPANTS} participants.`
                : 'Remove the selected participant'
        }
        aria-label="Remove selected Ensemble participant"
      >
        −
      </button>
      <div className="ensemble-above-row-actions">
        {/* "Queued next round" label intentionally not rendered here —
            the queued-messages above-row (sibling in the composer
            above-bar stack) now surfaces ensemble `queuedPrompt`
            entries as a full row with Edit / Delete / Steer actions,
            so duplicating the bare label here would be noise. See
            `QueuedMessagesAboveRow.tsx` + the
            `queuedMessagesAboveRowEntries` builder in App.tsx for
            the ensemble-queued branch. */}
        {isRoundRunning && activeRound?.activeParticipantId && onSkipActive && (
          <button
            type="button"
            className="btn btn-sm btn-ghost ensemble-above-row-skip"
            onClick={onSkipActive}
            title="Skip the currently-speaking participant and let the round continue with the next one. The composer's Stop button still cancels the whole round."
          >
            Skip
          </button>
        )}
      </div>
    </div>
  )
}

function EnsembleAddParticipantButton({
  disabled,
  title,
  composerStyle,
  grokAvailable,
  cursorAvailable,
  onAdd
}: {
  disabled: boolean
  title: string
  composerStyle: ComposerStyle
  grokAvailable: boolean
  cursorAvailable: boolean
  onAdd: (provider: ProviderId) => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const rows = resolveProviderRows(grokAvailable, cursorAvailable)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!open) {
        setPosition(null)
        return
      }
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340))
      const top = rect.top - 8
      setPosition({ left, top })
    })
    return () => {
      cancelled = true
    }
  }, [open, rows.length])

  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover shell-${composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Choose provider for new participant"
          >
            <ComposerProviderPickerRows
              rows={rows}
              activeProvider={rows[0]?.id || 'codex'}
              onSelect={(provider) => {
                onAdd(provider)
                setOpen(false)
              }}
            />
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ensemble-above-add-participant"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        title={title}
        aria-label="Add Ensemble participant"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        +
      </button>
      {popover}
    </>
  )
}

interface ParticipantChipProps {
  participant: EnsembleParticipant
  statusLabel: string
  /**
   * 1.0.4-AD — optional human-readable explanation surfaced in the
   * status-pill `title` tooltip. Populated from the round state's
   * `lastFailureReason` for `unreachable` (and `failed`) participants
   * so the user sees, e.g. "Codex app-server probe timed out after
   * 1000ms" without opening the transcript. Empty string falls back
   * to the bare status label.
   */
  statusTooltip: string
  dimmed: boolean
  isSelected: boolean
  isDragOver: boolean
  isDragging: boolean
  overflowOpen: boolean
  onClick: () => void
  /* 1.0.5-EW22 — `onToggleOverflow` removed; the parent now toggles
   * overflowOpenId directly when the user clicks an already-selected
   * chip. `onRemove` / `canRemove` removed too because the popover's
   * Remove row moved to the row's "-" sibling button (which has
   * direct access to `removeParticipant` from this component). */
  onCloseOverflow: () => void
  onPatch: (patch: Partial<EnsembleParticipant>) => void
  isBossman: boolean
  autoApprovalsEnabled: boolean
  onSetBossman: (participantId: string | undefined) => void
  onToggleBossmanAutoApprovals: (enabled: boolean) => void
  locked: boolean
  /**
   * Pointer-based drag callbacks (replaces HTML5 native drag).
   *
   * The HTML5 `draggable` attribute on a button — even one with a
   * working onClick handler — suppresses click events in Electron's
   * Chromium build. Tried wrapper-only draggable + button-only
   * draggable across two commits; both kept the symptom. Switched
   * to pointer events:
   *   - `pointerdown` on the chip starts a potential drag
   *   - if the pointer moves > 6px while held, it becomes a real
   *     drag (`onDragStart` fires)
   *   - `pointermove` updates the hover target via
   *     `document.elementFromPoint`
   *   - `pointerup` either fires `onClick` (pure tap, no movement)
   *     or `onDragEnd` with the chip id under the release point
   *     (a real drop)
   * Click events on the chip body now land reliably because no
   * native drag is competing for the pointer stream.
   */
  onDragStart: (info: ChipDragStartInfo) => void
  onDragMove: (pointerX: number, pointerY: number) => void
  onDragEnd: (pointerX: number, pointerY: number) => void
  /**
   * 1.0.4-AT7 — re-dispatch this participant after a failed /
   * unreachable turn. The chip strip computes whether retry is
   * applicable (status is failure-ish, no round running, etc.)
   * and only passes a callback when the action is valid; undefined
   * means "no retry row in the overflow popover".
   */
  onRetry?: () => void
  /**
   * 1.0.5-N7 — Wake-Now + Cancel for a sleeping participant. The
   * parent computes the pending wakeup record and only passes the
   * callbacks when there's actually a pending wakeup. wakeAt is
   * forwarded for the popover tooltip.
   */
  onWakeNow?: () => void
  onCancelWakeup?: () => void
  wakeAt?: string
}

function ParticipantChip({
  participant,
  statusLabel,
  statusTooltip,
  dimmed,
  isSelected,
  isDragOver,
  isDragging,
  overflowOpen,
  onClick,
  onCloseOverflow,
  onPatch,
  isBossman,
  autoApprovalsEnabled,
  onSetBossman,
  onToggleBossmanAutoApprovals,
  locked,
  onDragStart,
  onDragMove,
  onDragEnd,
  onRetry,
  onWakeNow,
  onCancelWakeup,
  wakeAt
}: ParticipantChipProps): React.JSX.Element {
  const [chipAnchor, setChipAnchor] = useState<HTMLDivElement | null>(null)
  // Slug the status onto the class so CSS can colour-code the pill
  // (running=warm, yielded=amber, answered=green, cancelled=muted, etc.).
  const statusClass = `status-${statusLabel.toLowerCase().replace(/\s+/g, '-')}`
  const providerClass = resolveProviderHueClass(participant.provider, participant.model)
  const providerDisplayName =
    resolveProviderBrandLabel(participant.provider, participant.model) ||
    getProviderName(participant.provider)
  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Left-click only. Right-click / middle-click fall through to
      // the browser default — no drag, no select.
      if (event.button !== 0) return
      // 1.0.5-EW40 — Skip when the event originated inside the
      // portaled popover. React portals propagate synthetic events
      // through the React tree, not the DOM tree — so a pointerdown
      // on the popover's Role input (or any input/button inside the
      // popover) bubbles up to THIS handler even though the popover
      // lives at <body> in the actual DOM. Without this guard, the
      // chip's pointerup-fires-onClick logic treats the popover
      // input click as a second tap on the selected chip and toggles
      // the popover closed before the user can type a character.
      // We check the DOM target's ancestry (not React's) because the
      // popover root is `.ensemble-above-overflow` regardless of
      // which chip anchored it, and that selector is collision-free
      // with everything else in the strip.
      const target = event.target as HTMLElement | null
      if (target?.closest('.ensemble-above-overflow')) return
      // 1.0.5-EW22 — Pre-EW22 there was a guard here for the inline
      // `⋯` overflow button. With that button removed (the popover
      // is now opened by clicking the selected chip a second time),
      // the guard is no longer needed.
      if (locked) {
        onClick()
        return
      }

      const startX = event.clientX
      const startY = event.clientY
      let dragged = false

      const chipElement = event.currentTarget as HTMLElement

      const handleMove = (moveEvent: PointerEvent): void => {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        // 6px movement threshold — under this is a tap, over is a drag.
        // Same magnitude HTML5 native drag uses; feels right on a
        // trackpad without making intentional drags feel sluggish.
        if (!dragged && (dx > 6 || dy > 6)) {
          dragged = true
          const chipRect = chipElement.getBoundingClientRect()
          onDragStart({
            pointerX: moveEvent.clientX,
            pointerY: moveEvent.clientY,
            chipRect,
            offsetX: moveEvent.clientX - chipRect.left,
            offsetY: moveEvent.clientY - chipRect.top
          })
        }
        if (dragged) {
          onDragMove(moveEvent.clientX, moveEvent.clientY)
        }
      }

      const handleUp = (upEvent: PointerEvent): void => {
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        document.removeEventListener('pointercancel', handleUp)
        if (dragged) {
          onDragEnd(upEvent.clientX, upEvent.clientY)
        } else {
          // Pure tap: no significant movement → fire the click handler.
          onClick()
        }
      }

      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
      document.addEventListener('pointercancel', handleUp)
    },
    [locked, onClick, onDragStart, onDragMove, onDragEnd]
  )

  return (
    <div
      ref={setChipAnchor}
      data-participant-id={participant.id}
      data-linked-session={participant.linkedProviderSessionId ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      className={`ensemble-above-chip provider-${providerClass} ${isSelected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''} ${isDragOver ? 'is-drag-over' : ''} ${isDragging ? 'is-dragging' : ''}`}
      // 1.0.4-AT1 — surface the participant's linked provider
      // session in the tooltip so the user can verify which thread
      // the next dispatch will resume against. Pre-AT1 there was
      // no chip-level signal at all; users had to dig into the
      // participant's detail popover to see linkage state.
      title={
        participant.linkedProviderSessionId
          ? `${isBossman ? 'Boss · ' : ''}${providerDisplayName} — ${participant.role || 'Participant'} · Linked session: ${participant.linkedProviderSessionId}`
          : `${isBossman ? 'Boss · ' : ''}${providerDisplayName} — ${participant.role || 'Participant'}`
      }
    >
      {/*
        Body is a `<div role="button">`, not a `<button>` element.
        Buttons + the surrounding pointerdown-based drag detection
        had subtle interactions (browser default mousedown handling
        on a button can interfere with capture-phase listeners),
        and a role-button div behaves identically for screen
        readers + keyboard while keeping the pointer pipeline
        completely under our control.
      */}
      <div
        className="ensemble-above-chip-body"
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        aria-label={`${isBossman ? 'Boss ' : ''}${participant.role || providerDisplayName}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
      >
        {/*
          1.0.5-EW24 — Removed the leading `<ProviderBadgeIcon>`.
          the maintainer flagged that the left-side icon read as ambiguous
          (users couldn't tell at a glance what it meant), while
          the right-side `ParticipantStatusIcon` carries
          unambiguous round-status semantics. The role text + its
          provider-tinted colour (from `.provider-${provider}` on
          the chip wrapper) is enough to identify the panelist
          without the redundant glyph. Token chip + status icon
          stay on the right edge.
        */}
        <span
          className="ensemble-above-chip-role"
          title={
            isBossman
              ? `Boss — ${participant.role || providerDisplayName}`
              : participant.role || providerDisplayName
          }
        >
          {isBossman ? <BossmanCrownIcon className="ensemble-above-chip-crown" /> : null}
          {participant.role || getProviderName(participant.provider)}
        </span>
        {/* 1.0.4-AV2 — per-participant token-spend chip. Renders
          inline between the role label and the status icon when
          the participant has accumulated 1k+ total tokens in this
          chat. Hidden below the 1k threshold so unspoken / freshly-
          spawned participants don't get a "0k" badge that reads as
          noise. Tooltip carries the precise input/output/duration
          breakdown for power users who hover. */}
        {(() => {
          const tokenChip = buildParticipantTokenChipModel(participant)
          if (!tokenChip.label) return null
          return (
            <span
              className="ensemble-above-chip-tokens"
              title={tokenChip.tooltip}
              aria-label={`${tokenChip.label} tokens — ${tokenChip.tooltip}`}
            >
              {tokenChip.label}
            </span>
          )
        })()}
        <span
          className={`ensemble-above-chip-status ${statusClass}`}
          aria-label={statusTooltip ? `${statusLabel}: ${statusTooltip}` : statusLabel}
          title={statusTooltip ? `${statusLabel} — ${statusTooltip}` : statusLabel}
        >
          <ParticipantStatusIcon status={statusLabel} />
        </span>
        {/*
          Inline retry affordance for failed/unreachable participants.
          The parent only passes `onRetry` when retry is actually
          applicable (failure status + no round running), so its mere
          presence gates visibility — no extra status check needed
          here. Surfacing it on the chip avoids the two-click dig
          (select → open popover → Retry). `stopPropagation` on
          pointerdown keeps the chip's drag/select pipeline from
          treating the click as a chip tap or drag start.
        */}
        {onRetry && (
          <button
            type="button"
            className="ensemble-above-chip-retry"
            title="Retry this participant's last turn"
            aria-label="Retry participant"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onRetry()
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              marginLeft: 2,
              border: 'none',
              background: 'transparent',
              color: 'currentColor',
              cursor: 'pointer',
              opacity: 0.85
            }}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13 8a5 5 0 1 1-1.5-3.6" />
              <path d="M13 2.5V5h-2.5" />
            </svg>
          </button>
        )}
      </div>
      {/*
        1.0.5-EW22 — The inline ⋯ overflow button used to live here.
        It overlapped into the next chip on dense rows and was an
        easy mis-click target. Replaced with a "click-twice-on-
        selected" gesture handled by the parent's chip onClick
        (see `EnsembleParticipantsAboveRow.tsx` near line 574).
      */}
      {overflowOpen && (
        <EnsembleParticipantOverflowPopover
          anchor={chipAnchor}
          participant={participant}
          onPatch={onPatch}
          isBossman={isBossman}
          autoApprovalsEnabled={autoApprovalsEnabled}
          onSetBossman={onSetBossman}
          onToggleBossmanAutoApprovals={onToggleBossmanAutoApprovals}
          locked={locked}
          onClose={onCloseOverflow}
          onRetry={onRetry}
          onWakeNow={onWakeNow}
          onCancelWakeup={onCancelWakeup}
          wakeAt={wakeAt}
        />
      )}
    </div>
  )
}

interface OverflowPopoverProps {
  anchor: HTMLElement | null
  participant: EnsembleParticipant
  onPatch: (patch: Partial<EnsembleParticipant>) => void
  isBossman: boolean
  autoApprovalsEnabled: boolean
  onSetBossman: (participantId: string | undefined) => void
  onToggleBossmanAutoApprovals: (enabled: boolean) => void
  /* 1.0.5-EW22 — `onRemove` / `canRemove` removed. Remove gesture
   * moved to the row's "-" sibling button. */
  locked: boolean
  onClose: () => void
  /** 1.0.4-AT7 — re-dispatch the participant when their last turn
   * failed. Optional; when omitted, the Retry row is hidden. */
  onRetry?: () => void
  /** 1.0.5-N7 — Wake-Now + Cancel rows for a sleeping participant.
   * Hidden when no callback (no pending wakeup). */
  onWakeNow?: () => void
  onCancelWakeup?: () => void
  wakeAt?: string
}

export function EnsembleParticipantOverflowPopover({
  anchor,
  participant,
  onPatch,
  isBossman,
  autoApprovalsEnabled,
  onSetBossman,
  onToggleBossmanAutoApprovals,
  locked,
  onClose,
  onRetry,
  onWakeNow,
  onCancelWakeup,
  wakeAt
}: OverflowPopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [rolePresetId, setRolePresetId] = useState(() => resolveRolePresetId(participant.role))

  useEffect(() => {
    setRolePresetId(resolveRolePresetId(participant.role))
  }, [participant.id, participant.role])

  // Buffer the freely-typed fields (custom Role + Goal/Brief) in LOCAL state so a
  // keystroke doesn't round-trip the whole chat through onChatChange + a saveChat
  // IPC. That round-trip echoes a stale chat back (chat-updated → setCurrentChat)
  // mid-typing — reverting the controlled value and DROPPING characters — and
  // also forced a full composer re-render per key. We persist on blur + on close
  // instead (mirrors RosterSettingsPanel's local-draft-until-blur).
  const [roleDraft, setRoleDraft] = useState(participant.role)
  const [instructionsDraft, setInstructionsDraft] = useState(participant.instructions)
  // Re-sync from the COMMITTED value only when it actually changes (participant
  // switch / external edit) — never on our own keystrokes, since the drafts are
  // local and participant.* doesn't move while typing, so typing isn't clobbered.
  useEffect(() => {
    setRoleDraft(participant.role)
  }, [participant.id, participant.role])
  useEffect(() => {
    setInstructionsDraft(participant.instructions)
  }, [participant.id, participant.instructions])

  // Latest-value refs so the unmount flush commits the final draft even though
  // the popover closes via outside-click / Escape / unmount WITHOUT blurring.
  const onPatchRef = useRef(onPatch)
  onPatchRef.current = onPatch
  const roleDraftRef = useRef(roleDraft)
  roleDraftRef.current = roleDraft
  const instructionsDraftRef = useRef(instructionsDraft)
  instructionsDraftRef.current = instructionsDraft
  const committedRef = useRef({ role: participant.role, instructions: participant.instructions })
  committedRef.current = { role: participant.role, instructions: participant.instructions }

  const commitDrafts = useCallback((): void => {
    const patch: Partial<EnsembleParticipant> = {}
    if (roleDraftRef.current !== committedRef.current.role) patch.role = roleDraftRef.current
    if (instructionsDraftRef.current !== committedRef.current.instructions) {
      patch.instructions = instructionsDraftRef.current
    }
    if (Object.keys(patch).length > 0) onPatchRef.current(patch)
  }, [])

  // Safety net: flush any unsaved draft when the popover unmounts — its close
  // paths (capture-phase outside mousedown, Escape, programmatic unmount) don't
  // blur the field first, so without this, closing would silently drop the text.
  useEffect(() => {
    return () => {
      commitDrafts()
    }
  }, [commitDrafts])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || !anchor) return
      const rect = anchor.getBoundingClientRect()
      const flyoutWidth = 260
      const left = Math.max(8, Math.min(window.innerWidth - flyoutWidth - 8, rect.left))
      const top = rect.top - 8
      setPosition({ left, top })
    })
    return () => {
      cancelled = true
    }
  }, [anchor])

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (popoverRef.current?.contains(event.target as Node)) return
      // 1.0.5-EW22 — Clicks on the chip the popover is anchored to
      // are handled by the chip's own onClick (toggle the popover).
      // Without this early-return, the mousedown closes the popover
      // before the pointerup re-opens it — net result of a click-
      // to-close gesture was visible flicker then re-open. Anchor-
      // chip clicks fall through; everything else closes.
      if (anchor && anchor.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose, anchor])

  if (!position) return null

  const content = (
    <div
      ref={popoverRef}
      className={`ensemble-above-overflow provider-${resolveProviderHueClass(participant.provider, participant.model)}`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label={`Edit ${isBossman ? 'Boss ' : ''}${getProviderName(participant.provider)} role and enabled state`}
    >
      <label className="ensemble-above-overflow-enable">
        <input
          type="checkbox"
          checked={participant.enabled}
          disabled={locked}
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        <span>Enabled in ensemble rounds</span>
      </label>
      <label className="ensemble-above-overflow-bossman">
        <input
          type="checkbox"
          checked={isBossman}
          disabled={locked}
          onChange={(event) => onSetBossman(event.target.checked ? participant.id : undefined)}
        />
        <span className="ensemble-above-overflow-bossman-label">
          <BossmanCrownIcon className="ensemble-above-overflow-crown" />
          Boss
        </span>
      </label>
      <label
        className={`ensemble-above-overflow-auto-approval${!isBossman ? ' is-disabled' : ''}`}
        title={
          isBossman
            ? 'Allow Boss to resolve preset-limited one-shot approvals.'
            : 'Assign this participant as Boss before enabling auto approvals.'
        }
      >
        <input
          type="checkbox"
          checked={autoApprovalsEnabled}
          disabled={locked || !isBossman}
          onChange={(event) => onToggleBossmanAutoApprovals(event.target.checked)}
        />
        <span>Allow Auto Approvals</span>
      </label>
      <label className="ensemble-above-overflow-role">
        <span className="ensemble-above-overflow-label">Role</span>
        <select
          className="ensemble-above-overflow-role-picker"
          value={rolePresetId}
          disabled={locked}
          onChange={(event) => {
            const nextPresetId = event.target.value
            setRolePresetId(nextPresetId)
            const presetLabel = roleLabelForPresetId(nextPresetId)
            if (presetLabel) {
              onPatch({ role: presetLabel })
            }
          }}
        >
          {ENSEMBLE_ROLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id} title={preset.description}>
              {preset.label}
            </option>
          ))}
          <option value={ENSEMBLE_ROLE_PRESET_CUSTOM}>Custom…</option>
        </select>
        {rolePresetId === ENSEMBLE_ROLE_PRESET_CUSTOM ? (
          <input
            type="text"
            value={roleDraft}
            disabled={locked}
            onChange={(event) => setRoleDraft(event.target.value)}
            onBlur={commitDrafts}
            placeholder={`${getProviderName(participant.provider)} role`}
          />
        ) : null}
      </label>
      <label className="ensemble-above-overflow-instructions">
        <span className="ensemble-above-overflow-label">Goal / brief</span>
        <textarea
          className="ensemble-above-overflow-instructions-field"
          rows={3}
          value={instructionsDraft}
          disabled={locked}
          onChange={(event) => setInstructionsDraft(event.target.value)}
          onBlur={commitDrafts}
          placeholder="Optional focus for this participant's turns…"
        />
      </label>
      {onRetry && (
        // 1.0.4-AT7 — Retry the participant's last turn. The strip
        // gates visibility on `status === 'failed' || 'unreachable'`
        // and `!isRoundRunning`, so this button only appears when
        // retry is actually a sensible action. Clicking it
        // re-dispatches as a DM via the AT4-extended
        // `runEnsembleRound` IPC path; the round closes on this
        // single participant's response.
        <button
          type="button"
          className="ensemble-above-overflow-retry"
          onClick={() => {
            onRetry()
            onClose()
          }}
        >
          Retry participant
        </button>
      )}
      {onWakeNow && (
        // 1.0.5-N7 — Wake the sleeping participant immediately,
        // bypassing the scheduled wakeAt. Same orchestrator path
        // as the timer firing naturally; the participant resumes
        // with the standard [Scheduled wakeup] prompt block.
        <button
          type="button"
          className="ensemble-above-overflow-wake-now"
          title={wakeAt ? `Originally scheduled for ${wakeAt}` : undefined}
          onClick={() => {
            onWakeNow()
            onClose()
          }}
        >
          Wake now
        </button>
      )}
      {onCancelWakeup && (
        // 1.0.5-N7 — Cancel the pending wakeup. The participant
        // exits the sleeping state but the round continues with
        // other participants. If you want the round itself to
        // stop, use the round-level Stop button instead.
        <button
          type="button"
          className="ensemble-above-overflow-cancel-wakeup"
          title={wakeAt ? `Cancels the scheduled wakeup at ${wakeAt}` : undefined}
          onClick={() => {
            onCancelWakeup()
            onClose()
          }}
        >
          Cancel wakeup
        </button>
      )}
      {/*
        1.0.5-EW22 — "Remove participant" moved to a sibling "-"
        button next to the row's "+" button, so the popover no
        longer carries the destructive row. Removing from the
        right-edge sibling is closer to the visual locus where
        users mentally bind "participant roster controls".
      */}
      <p className="ensemble-above-overflow-hint">
        {locked
          ? 'Participant membership is locked while a round is running.'
          : 'Model, provider, reasoning, fast mode, and permissions live in the composer pickers below — they apply to the chip selected here.'}
      </p>
    </div>
  )

  return createPortal(content, document.body)
}

function nextParticipantId(participants: EnsembleParticipant[]): string {
  const existing = new Set(participants.map((participant) => participant.id))
  for (let index = participants.length + 1; index < participants.length + 32; index += 1) {
    const id = `ensemble-participant-${index}`
    if (!existing.has(id)) return id
  }
  return `ensemble-participant-${Date.now().toString(36)}`
}

function nextRoleLabel(baseRole: string, participants: EnsembleParticipant[]): string {
  const base = (baseRole || 'Participant').replace(/\s+\d+$/, '').trim() || 'Participant'
  const existing = new Set(
    participants.map((participant) =>
      String(participant.role || '')
        .trim()
        .toLowerCase()
    )
  )
  if (!existing.has(base.toLowerCase())) return base
  for (let index = 2; index < 32; index += 1) {
    const candidate = `${base} ${index}`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${participants.length + 1}`
}

/*
 * `defaultEnsembleParticipants()` + `defaultRole()` deleted in 1.0.3.
 * The main process owns ensemble defaults via `EnsembleDefaults.ts` —
 * the renderer had a parallel implementation here from Slice D when
 * the setup-sheet modal seeded its own state, but with that modal
 * retired in Slice F there are no consumers in the renderer. Default
 * shape is whatever `chatService.createEnsembleChat()` returns from
 * the main process.
 */
