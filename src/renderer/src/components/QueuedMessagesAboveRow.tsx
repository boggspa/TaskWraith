/*
 * QueuedMessagesAboveRow — 1.0.3 ship-night.
 *
 * Renders the chat's pending run-queue jobs as a stack of bubbles
 * inside the composer's `.composer-above-bar-stack` (the same
 * container that holds the Ensemble chip strip and the Create-PR
 * row). Auto-joins Codex's unified-container via the existing
 * `> *:not(:first-child)` divider rule; in other shells it
 * renders as its own pill.
 *
 * Replaces the in-transcript "Queued (#2): …" system-card UX:
 * those cards remain in `chat.messages` for historical record
 * once the job actually dispatches, but while a job is still
 * `queued` the renderer hides the transcript card and shows it
 * here instead. See the dedup filter in `App.tsx:TranscriptPanel`.
 *
 * Per-row actions:
 *   - Edit  → hoist the queued prompt into the composer and remove
 *             the queue entry. Mirrors what most other ensemble-
 *             style chat apps do for the queue: edits become a
 *             fresh draft the user can revise.
 *   - Delete → cancel the queue job (status: 'cancelled') and drop
 *             it from the visible stack.
 *   - Steer  → cancel the chat's active run, then dispatch this
 *             queued item immediately. Same gentle handoff as
 *             clicking the composer's Steer button.
 *
 * Drag-to-reorder: pointer-based (same pattern as
 * EnsembleParticipantsAboveRow — HTML5 native drag suppresses
 * click events in Electron's Chromium, see that file's comment
 * for the history). Reorder is local-only for now; persisting
 * the order across restarts is a follow-up if it becomes worth
 * the IPC churn.
 *
 * Max 5 visible before scroll (overflow: auto on the inner list).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { ProviderBadgeIcon, getProviderName } from './Sidebar'
import { MentionHighlightedText } from './MentionHighlightedText'
import { formatScheduleCountdown } from '../lib/scheduledCountdown'

/**
 * Subset of `QueuedRunRequest` the row needs. Kept narrow so this
 * component doesn't depend on App.tsx-local types. The full request
 * envelope flows through the parent handlers — this component is
 * display + action plumbing only.
 */
export interface QueuedMessageRowEntry {
  /** Stable id used as the key for React and the target id for the
   * parent's action handlers. Backed by `appRunId` on the request. */
  id: string
  provider: ProviderId
  providerDisplayLabel?: string
  /** What the user typed (or the display variant if the prompt was
   * collapsed for readability). Truncated below for display. */
  prompt: string
  scheduledRunAt?: string
  /** Optional DM target participant id if this is an ensemble-chat
   * direct-message dispatch. Drives a tiny "→ Role" hint next to
   * the provider chip. */
  dmTargetParticipantId?: string
}

interface QueuedMessagesAboveRowProps {
  chat: ChatRecord | null
  entries: QueuedMessageRowEntry[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSteer: (id: string) => void
  onReorder: (orderedIds: string[]) => void
}

const PROMPT_PREVIEW_LIMIT = 220

function truncatePrompt(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= PROMPT_PREVIEW_LIMIT) return trimmed
  return `${trimmed.slice(0, PROMPT_PREVIEW_LIMIT)}…`
}

export function queuedMessageEntryProviderLabel(entry: QueuedMessageRowEntry): string {
  return entry.providerDisplayLabel?.trim() || getProviderName(entry.provider)
}

function getPositionedRowLabel(entry: QueuedMessageRowEntry, position: number, total: number): string {
  const prompt = truncatePrompt(entry.prompt)
  const positionLabel = `${position} of ${total}`
  const scheduleLabel = entry.scheduledRunAt ? ` scheduled for ${entry.scheduledRunAt}` : ''
  return `Queued message ${positionLabel} from ${queuedMessageEntryProviderLabel(entry)}${scheduleLabel}: ${prompt}`
}

function resolveDmRoleLabel(
  chat: ChatRecord | null,
  participantId: string | undefined
): string | null {
  if (!participantId || !chat?.ensemble?.participants) return null
  const participant = chat.ensemble.participants.find((p) => p.id === participantId)
  if (!participant) return null
  return participant.role?.trim() || getProviderName(participant.provider)
}

/*
 * 1.0.5-EW53 — Wrapped in React.memo to skip re-renders triggered
 * by unrelated parent (App) state changes. The composer draft state
 * lives at App-level, so every keystroke re-runs the App render
 * body; without memo here, this component also re-renders on every
 * keystroke even though its props (chat, entries, onEdit, onDelete, onSteer, onReorder)
 * are all `useMemo`/`useCallback`'d at the call site and don't
 * change. With memo, typing in the composer no longer drags this
 * subtree through the reconciler. Helps most on long threads where
 * the queue list has many entries to diff.
 */
function QueuedMessagesAboveRowImpl({
  chat,
  entries,
  onEdit,
  onDelete,
  onSteer,
  onReorder
}: QueuedMessagesAboveRowProps): React.JSX.Element | null {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const listRef = useRef<HTMLUListElement | null>(null)
  const hasScheduledEntries = entries.some((entry) => Boolean(entry.scheduledRunAt))

  useEffect(() => {
    if (!hasScheduledEntries) return
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [hasScheduledEntries])

  const handleReorder = useCallback(
    (sourceId: string, targetId: string | null) => {
      setDragId(null)
      setDragOverId(null)
      if (!targetId || sourceId === targetId) return
      const fromIdx = entries.findIndex((entry) => entry.id === sourceId)
      const toIdx = entries.findIndex((entry) => entry.id === targetId)
      if (fromIdx === -1 || toIdx === -1) return
      const next = [...entries]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      onReorder(next.map((entry) => entry.id))
    },
    [entries, onReorder]
  )

  const handleMove = useCallback(
    (sourceId: string, offset: -1 | 1) => {
      const sourceIndex = entries.findIndex((entry) => entry.id === sourceId)
      if (sourceIndex === -1) return
      const targetIndex = sourceIndex + offset
      if (targetIndex < 0 || targetIndex >= entries.length) return
      const next = [...entries]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      onReorder(next.map((entry) => entry.id))
    },
    [entries, onReorder]
  )

  if (!entries.length) return null

  return (
    <div className="queued-messages-above-row" role="region" aria-label="Queued messages">
      <ul
        className="queued-messages-above-row-list"
        role="list"
        ref={listRef}
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {entries.map((entry, index) => (
          <QueuedMessageRow
            key={entry.id}
            entry={entry}
            position={index + 1}
            total={entries.length}
            participants={chat?.ensemble?.participants}
            dmRoleLabel={resolveDmRoleLabel(chat, entry.dmTargetParticipantId)}
            isDragOver={dragOverId === entry.id && dragId !== entry.id}
            isDragging={dragId === entry.id}
            canMoveUp={index > 0}
            canMoveDown={index < entries.length - 1}
            onEdit={() => onEdit(entry.id)}
            onDelete={() => onDelete(entry.id)}
            onSteer={() => onSteer(entry.id)}
            nowMs={nowMs}
            onMoveUp={() => handleMove(entry.id, -1)}
            onMoveDown={() => handleMove(entry.id, 1)}
            onDragStart={() => setDragId(entry.id)}
            onDragHover={(overId) => setDragOverId(overId)}
            onDragEnd={(droppedOnId) => handleReorder(entry.id, droppedOnId)}
          />
        ))}
      </ul>
    </div>
  )
}

// 1.0.5-EW53 — Public memo'd export. Default shallow compare is
// fine because all incoming props are stable: `chat` is a ChatRecord
// reference (changes only on chat switch), `entries` is useMemo'd,
// and the four handlers are useCallback'd at the App.tsx call site.
export const QueuedMessagesAboveRow = memo(QueuedMessagesAboveRowImpl)

interface QueuedMessageRowProps {
  entry: QueuedMessageRowEntry
  position: number
  total: number
  /** Ensemble participants for the chat — used to tokenise `@Role`
   * mentions in the row's body text so the queued prompt shows
   * the same provider-tinted highlights as the composer overlay
   * and the user-bubble in the transcript. */
  participants?: import('../../../main/store/types').EnsembleParticipant[]
  dmRoleLabel: string | null
  isDragOver: boolean
  isDragging: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onEdit: () => void
  onDelete: () => void
  onSteer: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDragStart: () => void
  onDragHover: (overId: string | null) => void
  onDragEnd: (droppedOnId: string | null) => void
  nowMs: number
}

function QueuedMessageRow({
  entry,
  position,
  total,
  participants,
  dmRoleLabel,
  isDragOver,
  isDragging,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  onSteer,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragHover,
  onDragEnd,
  nowMs
}: QueuedMessageRowProps): React.JSX.Element {
  const rowLabel = getPositionedRowLabel(entry, position, total)
  const providerLabel = queuedMessageEntryProviderLabel(entry)
  const moveUpPosition = Math.max(position - 1, 1)
  const moveDownPosition = Math.min(position + 1, total)
  const scheduleCountdown = entry.scheduledRunAt
    ? formatScheduleCountdown(entry.scheduledRunAt, nowMs)
    : null

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Left-click only — right/middle clicks pass through.
      if (event.button !== 0) return
      // Skip drag-init if the user is clicking one of the action
      // buttons; those have their own click handlers and shouldn't
      // also trigger the pointer-drag path.
      const target = event.target as HTMLElement
      if (target.closest('.queued-messages-row-action')) return

      const startX = event.clientX
      const startY = event.clientY
      let dragged = false
      let lastHoverId: string | null = null

      const findRowUnderPointer = (x: number, y: number): string | null => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const row = el?.closest('.queued-messages-row[data-queued-id]') as HTMLElement | null
        return row?.getAttribute('data-queued-id') || null
      }

      const handleMove = (moveEvent: PointerEvent): void => {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        // 6px movement threshold — matches the ensemble chip drag.
        // Below this is a missed-tap; above is a real drag.
        if (!dragged && (dx > 6 || dy > 6)) {
          dragged = true
          onDragStart()
        }
        if (dragged) {
          const overId = findRowUnderPointer(moveEvent.clientX, moveEvent.clientY)
          if (overId !== lastHoverId) {
            lastHoverId = overId
            onDragHover(overId)
          }
        }
      }

      const handleUp = (upEvent: PointerEvent): void => {
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        document.removeEventListener('pointercancel', handleUp)
        if (dragged) {
          const dropId = findRowUnderPointer(upEvent.clientX, upEvent.clientY)
          onDragEnd(dropId && dropId !== entry.id ? dropId : null)
        }
        // Pure-tap on the body is a no-op — the row body has no click
        // affordance beyond the explicit action buttons. Edit / Delete
        // / Steer have their own handlers and don't reach here.
      }

      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
      document.addEventListener('pointercancel', handleUp)
    },
    [entry.id, onDragStart, onDragHover, onDragEnd]
  )

  return (
    <li
      role="listitem"
      aria-label={rowLabel}
      aria-posinset={position}
      aria-setsize={total}
      data-queued-id={entry.id}
      onPointerDown={handlePointerDown}
      className={`queued-messages-row provider-${entry.provider} ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
      title={`${rowLabel}. Drag to reorder.`}
    >
      <span className="queued-messages-row-meta" aria-hidden>
        <ProviderBadgeIcon provider={entry.provider} />
        <span className="queued-messages-row-position">#{position}</span>
        {dmRoleLabel && <span className="queued-messages-row-dm">→ {dmRoleLabel}</span>}
      </span>
      <span className="queued-messages-row-body">
        <MentionHighlightedText value={truncatePrompt(entry.prompt)} participants={participants} />
      </span>
      <span className="queued-messages-row-actions">
        <button
          type="button"
          className="queued-messages-row-action queued-messages-row-action-move"
          onClick={(event) => {
            event.stopPropagation()
            onMoveUp()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          disabled={!canMoveUp}
          title={`Move queued message ${position} to position ${moveUpPosition} in the queue.`}
          aria-label={`Move ${providerLabel} queued message ${position} up to ${moveUpPosition} in the queue`}
        >
          ↑
        </button>
        <button
          type="button"
          className="queued-messages-row-action queued-messages-row-action-move"
          onClick={(event) => {
            event.stopPropagation()
            onMoveDown()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          disabled={!canMoveDown}
          title={`Move queued message ${position} to position ${moveDownPosition} in the queue.`}
          aria-label={`Move ${providerLabel} queued message ${position} down to ${moveDownPosition} in the queue`}
        >
          ↓
        </button>
        {scheduleCountdown ? (
          <span
            className="queued-messages-row-action queued-messages-row-action-scheduled"
            title={`Scheduled ${providerLabel} queued message ${position} dispatches in ${scheduleCountdown}.`}
            aria-label={`Scheduled ${providerLabel} queued message ${position} dispatches in ${scheduleCountdown}`}
          >
            {scheduleCountdown === 'due now' ? 'Due' : scheduleCountdown}
          </span>
        ) : (
          <button
            type="button"
            className="queued-messages-row-action queued-messages-row-action-steer"
            onClick={(event) => {
              event.stopPropagation()
              onSteer()
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={`Steer ${providerLabel} queued message ${position}: dispatch this queued message now.`}
            aria-label={`Steer ${providerLabel} queued message ${position} from the queue now`}
          >
            ↳ Steer
          </button>
        )}
        <button
          type="button"
          className="queued-messages-row-action queued-messages-row-action-edit"
          onClick={(event) => {
            event.stopPropagation()
            onEdit()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={`Edit ${providerLabel} queued message ${position}: load this prompt into the composer.`}
          aria-label={`Edit ${providerLabel} queued message ${position} in the composer`}
        >
          Edit
        </button>
        <button
          type="button"
          className="queued-messages-row-action queued-messages-row-action-delete"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={`Delete ${providerLabel} queued message ${position} from the queue.`}
          aria-label={`Delete ${providerLabel} queued message ${position} from the queue`}
        >
          ✕
        </button>
      </span>
    </li>
  )
}
