import { useEffect, useRef, useState } from 'react'

export function CopyEntireTurnButton({ onCopy }: { onCopy: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const label =
    state === 'copied'
      ? 'Entire turn copied'
      : state === 'copying'
        ? 'Copying entire turn…'
        : state === 'failed'
          ? 'Could not copy entire turn. Click to retry.'
          : 'Copy Entire Turn'
  return (
    <button
      type="button"
      className={`message-actions-chip-button message-actions-chip-button--copy-turn${state === 'copied' ? ' is-copied' : ''}`}
      title={label}
      aria-label={label}
      disabled={state === 'copying'}
      onClick={async () => {
        if (timer.current) clearTimeout(timer.current)
        setState('copying')
        try {
          await onCopy()
          setState('copied')
          timer.current = setTimeout(() => setState('idle'), 1500)
        } catch {
          setState('failed')
        }
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {state === 'copied' ? (
          <path d="m5 12 4 4L19 6" />
        ) : state === 'failed' ? (
          <path d="M12 5v9m0 4h.01" />
        ) : (
          <>
            <rect x="7" y="7" width="14" height="14" rx="2" />
            <path d="M17 3H5a2 2 0 0 0-2 2v12M11 11h6m-6 4h6m-6 3h4" />
          </>
        )}
      </svg>
      <span className="sr-only" role="status">
        {state === 'copied' || state === 'failed' ? label : ''}
      </span>
    </button>
  )
}
