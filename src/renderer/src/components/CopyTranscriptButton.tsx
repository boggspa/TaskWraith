import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
      reason: 'not-found' | 'archived' | 'empty' | 'too-large' | 'unauthorized'
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
  onCopy: () => Promise<CopyTranscriptResult>
  onCopyMessages: () => Promise<CopyTranscriptResult>
  onDownload: () => Promise<CopyTranscriptResult>
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
  // The action rides along with the result: `completedAction` clears itself on
  // a timer (it drives the trigger's transient tick), but the summary line
  // stays until the popover closes and still has to name what it did.
  const [summary, setSummary] = useState<{
    action: TranscriptAction
    result: Extract<CopyTranscriptResult, { ok: true }>
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
    setOpen(true)
  }, [clearFeedback, disabled])

  useEffect(() => {
    setOpen(false)
    setBusyAction(null)
    setCompletedAction(null)
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

  const run = async (action: TranscriptAction): Promise<void> => {
    if (disabled || busyAction) return
    setBusyAction(action)
    setError(null)
    try {
      const result = await (action === 'messages'
        ? onCopyMessages()
        : action === 'download'
          ? onDownload()
          : onCopy())
      if (result.ok) {
        setSummary({ action, result })
        setCompletedAction(action)
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
