import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CopyResponseIcon } from './AppChromeSymbols'

export type CopyTranscriptResult =
  | {
      ok: true
      messageCount: number
      charCount: number
      omissions: string[]
    }
  | {
      ok: false
      reason: 'not-found' | 'archived' | 'empty' | 'too-large' | 'unauthorized'
      messageCount?: number
      charCount?: number
      omissions?: string[]
    }

interface CopyTranscriptButtonProps {
  disabled?: boolean
  defaultOpen?: boolean
  initialCopied?: boolean
  resetKey?: string | null
  onCopy: () => Promise<CopyTranscriptResult>
}

function failureMessage(result: Extract<CopyTranscriptResult, { ok: false }>): string {
  if (result.reason === 'not-found') return 'This chat could not be loaded.'
  if (result.reason === 'archived') return 'Archived chats cannot be copied from here.'
  if (result.reason === 'too-large') return 'This transcript is too large for clipboard copy.'
  if (result.reason === 'unauthorized') return 'This window is not allowed to copy transcripts.'
  return 'There is no transcript content to copy yet.'
}

export function CopyTranscriptButton({
  disabled = false,
  defaultOpen = false,
  initialCopied = false,
  resetKey = null,
  onCopy
}: CopyTranscriptButtonProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(initialCopied)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Extract<CopyTranscriptResult, { ok: true }> | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
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
    const popoverWidth = 300
    const edgePadding = 16
    const minLeft = edgePadding + popoverWidth / 2
    const maxLeft = Math.max(minLeft, window.innerWidth - edgePadding - popoverWidth / 2)
    const left = Math.min(Math.max(rect.left + rect.width / 2, minLeft), maxLeft)
    const top = Math.max(edgePadding, rect.top - 8)
    setPosition({ left, top })
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
    setBusy(false)
    setCopied(false)
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
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    if (disabled || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onCopy()
      if (result.ok) {
        setSummary(result)
        setCopied(true)
        return
      }
      setSummary(null)
      setError(failureMessage(result))
    } catch (err) {
      setSummary(null)
      setError(err instanceof Error ? err.message : 'Transcript copy failed.')
    } finally {
      setBusy(false)
    }
  }

  const popover = open ? (
    <div
      ref={popoverRef}
      className="composer-copy-transcript-popover"
      role="dialog"
      aria-label="Copy transcript"
      style={position ? { left: `${position.left}px`, top: `${position.top}px` } : undefined}
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
      <p>Creates safe handoff Markdown from visible transcript content.</p>
      <button
        ref={primaryRef}
        type="button"
        className="composer-copy-transcript-primary"
        onClick={() => void copy()}
        disabled={busy || disabled}
      >
        {busy ? 'Copying...' : 'Copy handoff Markdown'}
      </button>
      {summary && (
        <div className="composer-copy-transcript-status" role="status">
          Copied {summary.messageCount} message{summary.messageCount === 1 ? '' : 's'}.
          {summary.omissions.length > 0 && <span> {summary.omissions.join('; ')}.</span>}
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
        className={`composer-copy-transcript-button composer-hint-pill${open ? ' is-open' : ''}${copied ? ' is-copied' : ''}`}
        data-hint-label="Copy transcript"
        onClick={() => {
          if (disabled) return
          if (open) closePopover(false)
          else openPopover()
        }}
        title={copied ? 'Copied transcript as Markdown' : 'Copy transcript as Markdown'}
        aria-label={copied ? 'Copied transcript as Markdown' : 'Copy transcript as Markdown'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <CopyResponseIcon />
        {copied && (
          <span className="composer-copy-transcript-check" aria-hidden="true">
            ✓
          </span>
        )}
      </button>
      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </span>
  )
}
