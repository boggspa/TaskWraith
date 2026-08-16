import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  TranscriptExportRound,
  TranscriptExportScope
} from '../../../shared/transcriptExportScope'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import { CopyResponseIcon } from './AppChromeSymbols'

export type CopyTranscriptResult =
  | {
      ok: true
      messageCount: number
      charCount: number
      omissions: string[]
      /** Set by the download action only — the name the file was saved under. */
      fileName?: string
    }
  | {
      ok: false
      reason:
        | 'not-found'
        | 'archived'
        | 'empty'
        | 'too-large'
        | 'unauthorized'
        | 'invalid-scope'
        | 'round-not-found'
        | 'cancelled'
        | 'save-failed'
      messageCount?: number
      charCount?: number
      omissions?: string[]
    }

type TranscriptAction = 'handoff' | 'messages' | 'download'

interface CopyTranscriptButtonProps {
  disabled?: boolean
  defaultOpen?: boolean
  initialCopied?: boolean
  resetKey?: string | null
  composerStyle?: string
  /** Evaluated only when the sheet opens, not on every streaming chat update. */
  getRounds?: () => readonly TranscriptExportRound[]
  onCopy: (scope: TranscriptExportScope) => Promise<CopyTranscriptResult>
  onCopyMessages: (scope: TranscriptExportScope) => Promise<CopyTranscriptResult>
  onDownload: (scope: TranscriptExportScope) => Promise<CopyTranscriptResult>
}

interface ScopePickerState {
  rounds: TranscriptExportRound[]
  selected: TranscriptExportScope
  chooserOpen: boolean
  query: string
}

function defaultScopePickerState(
  getRounds: (() => readonly TranscriptExportRound[]) | undefined,
  loadRounds: boolean
): ScopePickerState {
  const rounds = loadRounds ? [...(getRounds?.() ?? [])] : []
  const currentRound = rounds[rounds.length - 1]
  return {
    rounds,
    selected: currentRound
      ? { kind: 'round', roundId: currentRound.roundId }
      : { kind: 'entire-task' },
    chooserOpen: false,
    query: ''
  }
}

function formatRoundTime(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 'Time unavailable'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(parsed)
}

function formatRoundDuration(round: TranscriptExportRound): string {
  const startedAt = Date.parse(round.startedAt)
  const endedAt = round.endedAt ? Date.parse(round.endedAt) : Date.now()
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return 'Duration unavailable'
  }
  const totalSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function roundStatusLabel(status: TranscriptExportRound['status']): string {
  return status === 'unknown' ? 'Status unknown' : `${status[0].toUpperCase()}${status.slice(1)}`
}

function failureMessage(
  result: Extract<CopyTranscriptResult, { ok: false }>,
  action: TranscriptAction
): string {
  const download = action === 'download'
  if (result.reason === 'not-found') return 'This chat could not be loaded.'
  if (result.reason === 'archived')
    return download
      ? 'Archived chats cannot be downloaded from here.'
      : 'Archived chats cannot be copied from here.'
  if (result.reason === 'too-large')
    return download
      ? 'This transcript is too large to download.'
      : 'This transcript is too large for clipboard copy.'
  if (result.reason === 'unauthorized')
    return download
      ? 'This window is not allowed to download transcripts.'
      : 'This window is not allowed to copy transcripts.'
  if (result.reason === 'invalid-scope') return 'That transcript scope is not valid.'
  if (result.reason === 'round-not-found') return 'That round is no longer available.'
  if (result.reason === 'save-failed') return 'The transcript could not be saved.'
  return download
    ? 'There is no transcript content to download yet.'
    : 'There is no transcript content to copy yet.'
}

export function CopyTranscriptButton({
  disabled = false,
  defaultOpen = false,
  initialCopied = false,
  resetKey = null,
  composerStyle = 'default',
  getRounds,
  onCopy,
  onCopyMessages,
  onDownload
}: CopyTranscriptButtonProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [busyAction, setBusyAction] = useState<TranscriptAction | null>(null)
  const [completedAction, setCompletedAction] = useState<TranscriptAction | null>(
    initialCopied ? 'handoff' : null
  )
  const [error, setError] = useState<string | null>(null)
  const [scopePicker, setScopePicker] = useState<ScopePickerState>(() =>
    defaultScopePickerState(getRounds, defaultOpen)
  )
  // The action rides along with the result: `completedAction` clears itself on
  // a timer (it drives the trigger's transient tick), but the summary line
  // stays until the popover closes and still has to name what it did.
  const [summary, setSummary] = useState<{
    action: TranscriptAction
    result: Extract<CopyTranscriptResult, { ok: true }>
    scopeLabel: string
  } | null>(null)
  const [position, setPosition] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)

  const clearFeedback = useCallback((): void => {
    setError(null)
    setSummary(null)
  }, [])

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect() ?? rect
    setPosition(
      resolveComposerSurfacePopoverPosition({
        triggerRect: rect,
        surfaceRect,
        viewportWidth: window.innerWidth
      })
    )
  }, [])

  const closePopover = useCallback(
    (restoreFocus = true): void => {
      setOpen(false)
      clearFeedback()
      if (restoreFocus && typeof window !== 'undefined') {
        window.setTimeout(() => triggerRef.current?.focus(), 0)
      }
    },
    [clearFeedback]
  )

  const openPopover = useCallback((): void => {
    if (disabled) return
    clearFeedback()
    setScopePicker(defaultScopePickerState(getRounds, true))
    setOpen(true)
  }, [clearFeedback, disabled, getRounds])

  useEffect(() => {
    setOpen(false)
    setBusyAction(null)
    setCompletedAction(null)
    setScopePicker(defaultScopePickerState(undefined, false))
    clearFeedback()
  }, [clearFeedback, resetKey])

  useEffect(() => {
    if (disabled && open) closePopover(false)
  }, [closePopover, disabled, open])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePosition()
    const focusFrame = window.requestAnimationFrame(() => primaryRef.current?.focus())
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    const handlePointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      closePopover(false)
    }
    const handleReposition = (): void => updatePosition()
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [closePopover, open, updatePosition])

  useEffect(() => {
    if (!completedAction) return
    const timer = window.setTimeout(() => setCompletedAction(null), 1600)
    return () => window.clearTimeout(timer)
  }, [completedAction])

  const currentRound = scopePicker.rounds[scopePicker.rounds.length - 1] ?? null
  const previousRound = scopePicker.rounds[scopePicker.rounds.length - 2] ?? null
  const selectedRoundId =
    scopePicker.selected.kind === 'round' ? scopePicker.selected.roundId : null
  const selectedRound = selectedRoundId
    ? scopePicker.rounds.find((round) => round.roundId === selectedRoundId) ?? null
    : null
  const selectedIsCurrent = Boolean(
    selectedRound && currentRound && selectedRound.roundId === currentRound.roundId
  )
  const selectedIsPrevious = Boolean(
    selectedRound && previousRound && selectedRound.roundId === previousRound.roundId
  )
  const selectedIsChosen = Boolean(selectedRound && !selectedIsCurrent && !selectedIsPrevious)
  const selectedScopeLabel =
    scopePicker.selected.kind === 'entire-task'
      ? 'Entire task'
      : selectedIsCurrent
        ? 'Current round'
        : selectedIsPrevious
          ? 'Previous round'
          : selectedRound
            ? `Round ${selectedRound.ordinal}`
            : 'Selected round'
  const filteredRounds = useMemo(() => {
    const query = scopePicker.query.trim().toLowerCase()
    const newestFirst = [...scopePicker.rounds].reverse()
    if (!query) return newestFirst
    return newestFirst.filter((round) =>
      [
        `round ${round.ordinal}`,
        round.prompt,
        round.status,
        `${round.hops} hops`,
        `${round.participantCount} participants`,
        ...round.participantLabels,
        formatRoundTime(round.startedAt),
        formatRoundDuration(round)
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [scopePicker.query, scopePicker.rounds])

  const selectRound = (round: TranscriptExportRound, closeChooser = true): void => {
    setScopePicker((current) => ({
      ...current,
      selected: { kind: 'round', roundId: round.roundId },
      chooserOpen: closeChooser ? false : current.chooserOpen,
      query: closeChooser ? '' : current.query
    }))
    clearFeedback()
  }

  const run = async (action: TranscriptAction): Promise<void> => {
    if (disabled || busyAction) return
    setBusyAction(action)
    setError(null)
    const requestedScope = scopePicker.selected
    const requestedScopeLabel = selectedScopeLabel
    try {
      const result = await (action === 'messages'
        ? onCopyMessages(requestedScope)
        : action === 'download'
          ? onDownload(requestedScope)
          : onCopy(requestedScope))
      if (result.ok) {
        setSummary({ action, result, scopeLabel: requestedScopeLabel })
        setCompletedAction(action)
        return
      }
      if (result.reason === 'cancelled') {
        setSummary(null)
        return
      }
      setSummary(null)
      setError(failureMessage(result, action))
    } catch (err) {
      setSummary(null)
      setError(
        err instanceof Error
          ? err.message
          : action === 'download'
            ? 'Transcript download failed.'
            : 'Transcript copy failed.'
      )
    } finally {
      setBusyAction(null)
    }
  }

  const popover = open ? (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover composer-copy-transcript-popover shell-${composerStyle}`}
      role="dialog"
      aria-label="Copy transcript"
      style={
        position
          ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
              maxWidth: 'calc(100vw - 16px)'
            }
          : undefined
      }
    >
      <div className="composer-copy-transcript-popover-header">
        <span>Copy transcript</span>
        <button
          type="button"
          className="composer-copy-transcript-close"
          onClick={() => closePopover()}
          aria-label="Close copy transcript"
        >
          Close
        </button>
      </div>
      <p>
        Creates safe handoff Markdown, copies raw conversation messages only, or downloads the
        transcript as a .md file.
      </p>
      <div className="composer-copy-transcript-scope">
        <div className="composer-copy-transcript-scope-heading">
          <span>Scope</span>
          <span>{selectedScopeLabel}</span>
        </div>
        <div
          className="composer-copy-transcript-scope-options"
          role="radiogroup"
          aria-label="Transcript scope"
        >
          <button
            type="button"
            className={selectedIsCurrent ? 'is-selected' : ''}
            aria-pressed={selectedIsCurrent}
            disabled={disabled || !currentRound || Boolean(busyAction)}
            onClick={() => currentRound && selectRound(currentRound)}
          >
            Current round
          </button>
          <button
            type="button"
            className={selectedIsPrevious ? 'is-selected' : ''}
            aria-pressed={selectedIsPrevious}
            disabled={disabled || !previousRound || Boolean(busyAction)}
            onClick={() => previousRound && selectRound(previousRound)}
          >
            Previous round
          </button>
          <button
            type="button"
            className={selectedIsChosen || scopePicker.chooserOpen ? 'is-selected' : ''}
            aria-pressed={selectedIsChosen}
            aria-expanded={scopePicker.chooserOpen}
            disabled={disabled || scopePicker.rounds.length === 0 || Boolean(busyAction)}
            onClick={() => {
              clearFeedback()
              setScopePicker((current) => ({
                ...current,
                chooserOpen: !current.chooserOpen,
                query: ''
              }))
            }}
          >
            Choose round…
          </button>
          <button
            type="button"
            className={scopePicker.selected.kind === 'entire-task' ? 'is-selected' : ''}
            aria-pressed={scopePicker.selected.kind === 'entire-task'}
            disabled={disabled || Boolean(busyAction)}
            onClick={() => {
              clearFeedback()
              setScopePicker((current) => ({
                ...current,
                selected: { kind: 'entire-task' },
                chooserOpen: false,
                query: ''
              }))
            }}
          >
            Entire task
          </button>
        </div>
        {scopePicker.chooserOpen && (
          <div className="composer-copy-transcript-round-chooser">
            <input
              type="search"
              value={scopePicker.query}
              onChange={(event) =>
                setScopePicker((current) => ({ ...current, query: event.target.value }))
              }
              placeholder="Search rounds, status, or participants"
              aria-label="Search transcript rounds"
            />
            <div className="composer-copy-transcript-round-list" role="listbox">
              {filteredRounds.map((round) => {
                const selected = selectedRound?.roundId === round.roundId
                return (
                  <button
                    key={round.roundId}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? 'is-selected' : ''}
                    onClick={() => selectRound(round)}
                  >
                    <span className="composer-copy-transcript-round-title">
                      <strong>Round {round.ordinal}</strong>
                      <span>{roundStatusLabel(round.status)}</span>
                    </span>
                    <span className="composer-copy-transcript-round-prompt">
                      {round.prompt || 'No prompt recorded'}
                    </span>
                    <span className="composer-copy-transcript-round-meta">
                      {formatRoundTime(round.startedAt)} · {formatRoundDuration(round)} ·{' '}
                      {round.hops} hop{round.hops === 1 ? '' : 's'} · {round.participantCount}{' '}
                      participant{round.participantCount === 1 ? '' : 's'}
                    </span>
                    {round.participantLabels.length > 0 && (
                      <span className="composer-copy-transcript-round-participants">
                        {round.participantLabels.join(', ')}
                      </span>
                    )}
                  </button>
                )
              })}
              {filteredRounds.length === 0 && (
                <span className="composer-copy-transcript-round-empty">No matching rounds.</span>
              )}
            </div>
          </div>
        )}
        {scopePicker.selected.kind === 'entire-task' && (
          <span className="composer-copy-transcript-stream-note">
            Downloads stream directly to disk and never enter renderer memory.
          </span>
        )}
      </div>
      <div className="composer-copy-transcript-actions">
        <button
          type="button"
          className="composer-copy-transcript-secondary"
          onClick={() => void run('download')}
          disabled={Boolean(busyAction) || disabled}
        >
          {busyAction === 'download' ? 'Saving...' : 'Download'}
        </button>
        <button
          type="button"
          className="composer-copy-transcript-secondary"
          onClick={() => void run('messages')}
          disabled={Boolean(busyAction) || disabled}
        >
          {busyAction === 'messages' ? 'Copying...' : 'Copy Messages'}
        </button>
        <button
          ref={primaryRef}
          type="button"
          className="composer-copy-transcript-primary"
          onClick={() => void run('handoff')}
          disabled={Boolean(busyAction) || disabled}
        >
          {busyAction === 'handoff' ? 'Copying...' : 'Copy Markdown'}
        </button>
      </div>
      {summary && (
        <div className="composer-copy-transcript-status" role="status">
          {summary.action === 'download' ? 'Downloaded' : 'Copied'} {summary.result.messageCount}{' '}
          message{summary.result.messageCount === 1 ? '' : 's'}
          {` from ${summary.scopeLabel}`}
          {summary.action === 'download' && summary.result.fileName
            ? ` to ${summary.result.fileName}`
            : ''}
          .
          {summary.result.omissions.length > 0 && (
            <span> {summary.result.omissions.join('; ')}.</span>
          )}
        </div>
      )}
      {error && (
        <div className="composer-copy-transcript-error" role="alert">
          {error}
        </div>
      )}
    </div>
  ) : null

  return (
    <span className="composer-copy-transcript-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-copy-transcript-button composer-hint-pill composer-hint-pill--left${open ? ' is-open' : ''}${completedAction ? ' is-copied' : ''}`}
        data-hint-label="Copy transcript"
        onClick={() => {
          if (disabled) return
          if (open) closePopover(false)
          else openPopover()
        }}
        aria-label={
          completedAction === 'messages'
            ? 'Copied messages'
            : completedAction === 'download'
              ? 'Downloaded transcript as Markdown'
              : completedAction === 'handoff'
                ? 'Copied transcript as Markdown'
                : 'Copy transcript as Markdown'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <CopyResponseIcon />
        {completedAction && (
          <span className="composer-copy-transcript-check" aria-hidden="true">
            ✓
          </span>
        )}
      </button>
      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </span>
  )
}
