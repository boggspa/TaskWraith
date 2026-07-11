import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * CommittedDraftField — a controlled text <input>/<textarea> that BUFFERS
 * keystrokes locally and only persists on blur (plus on unmount, as a safety
 * net for closing without a blur).
 *
 * Why this exists: persisting every keystroke through a heavy/shared sink — a
 * chat `saveChat` IPC + the `chat-updated` echo, or an `updateSettings`
 * write — makes the controlled value LAG and revert
 * mid-typing, so characters drop and typing turns jerky (see the memory
 * "renderer-input-echo-clobber"). Buffering locally decouples typing from that
 * round-trip; we commit the final value once, on blur / unmount.
 *
 * The draft re-syncs from `committed` only when that value actually CHANGES
 * (a record switch or an external edit) — never on our own keystrokes, because
 * the draft is local and `committed` doesn't move while typing, so an
 * in-progress edit can't be clobbered.
 */

interface CommittedDraftBase {
  /** The persisted value this field mirrors. */
  committed: string
  /** Persist the draft. Called on blur and on unmount — only when it changed. */
  onCommit: (value: string) => void
  /**
   * Optional per-keystroke callback for a LIVE, NON-PERSISTING preview (e.g.
   * applying a font to the document as the user types) — decoupled from the
   * heavy `onCommit` write. Fires on every keystroke; must never persist.
   * Omitted by most callers → the field behaves as pure commit-on-blur.
   */
  onDraftChange?: (value: string) => void
}

type CommittedDraftInputProps = CommittedDraftBase & {
  as?: 'input'
} & Omit<
    React.ComponentPropsWithoutRef<'input'>,
    'value' | 'onChange' | 'onBlur' | 'defaultValue'
  >

type CommittedDraftTextareaProps = CommittedDraftBase & {
  as: 'textarea'
} & Omit<
    React.ComponentPropsWithoutRef<'textarea'>,
    'value' | 'onChange' | 'onBlur' | 'defaultValue'
  >

export type CommittedDraftFieldProps = CommittedDraftInputProps | CommittedDraftTextareaProps

export function CommittedDraftField(props: CommittedDraftFieldProps): React.JSX.Element {
  const { committed, onCommit, onDraftChange, as, ...rest } = props
  const [draft, setDraft] = useState(committed)
  useEffect(() => {
    setDraft(committed)
  }, [committed])

  // Latest-value refs so the unmount flush reads the final draft even though a
  // panel/popover can close without first firing the field's blur.
  const committedRef = useRef(committed)
  committedRef.current = committed
  const draftRef = useRef(draft)
  draftRef.current = draft
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const flush = useCallback((): void => {
    if (draftRef.current !== committedRef.current) onCommitRef.current(draftRef.current)
  }, [])

  useEffect(() => () => flush(), [flush])

  if (as === 'textarea') {
    return (
      <textarea
        {...(rest as React.ComponentPropsWithoutRef<'textarea'>)}
        value={draft}
        onChange={(event) => {
          const value = event.target.value
          setDraft(value)
          onDraftChange?.(value)
        }}
        onBlur={flush}
      />
    )
  }
  return (
    <input
      {...(rest as React.ComponentPropsWithoutRef<'input'>)}
      value={draft}
      onChange={(event) => {
        const value = event.target.value
        setDraft(value)
        onDraftChange?.(value)
      }}
      onBlur={flush}
    />
  )
}
