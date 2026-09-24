import type { SelectedChatHydrationState } from '../lib/SelectedChatHydrationRecovery'

export function TranscriptHydrationNotice({
  state,
  onRetry
}: {
  state: SelectedChatHydrationState | null
  onRetry: () => void
}): React.JSX.Element | null {
  if (!state) return null
  const failed = state.phase === 'failed'
  return (
    <div
      className={`transcript-stall-notice transcript-stall-notice--${failed ? 'stalled' : 'catching-up'}`}
      role="status"
      aria-live="polite"
    >
      <span className="transcript-stall-notice__label">
        {failed ? 'Couldn’t load saved transcript.' : 'Loading saved transcript…'}
      </span>
      {failed && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
