import { useCallback, useSyncExternalStore } from 'react'
import {
  getTranscriptStallSnapshot,
  subscribeTranscriptStall,
  type TranscriptStallSnapshot
} from '../lib/transcriptStallStore'

/**
 * Says out loud that the transcript is behind.
 *
 * On 2026-09-11 a live round ran 52 seconds with nothing on screen, and the
 * only reason it was ever noticed is that a person happened to be watching and
 * said so. Every counter read healthy. A frozen transcript and an idle one were
 * pixel-identical. That is the gap this closes: whatever else fails, the user
 * is told, with a number, rather than left to guess whether the app is thinking
 * or dead.
 *
 * Renders nothing at all while current — which is almost always — so it costs a
 * store read per chat render and no layout.
 */

function describe(snapshot: TranscriptStallSnapshot): string {
  const seconds = Math.round(snapshot.lagMs / 1_000)
  if (snapshot.level === 'stalled') {
    return seconds >= 60
      ? `Transcript is ${Math.floor(seconds / 60)}m ${seconds % 60}s behind`
      : `Transcript is ${seconds}s behind`
  }
  return 'Catching up on new messages'
}

export function TranscriptStallNotice({
  chatId
}: {
  chatId?: string | null
}): React.JSX.Element | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTranscriptStall(chatId, listener),
    [chatId]
  )
  const getSnapshot = useCallback(() => getTranscriptStallSnapshot(chatId), [chatId])
  // The store returns a shared constant while current, so the identity check
  // useSyncExternalStore performs does not churn on every tick.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (snapshot.level === 'current') return null

  return (
    <div
      className={`transcript-stall-notice transcript-stall-notice--${snapshot.level}`}
      role="status"
      // Polite, not assertive: this is ambient progress, and a screen reader
      // interrupting mid-sentence to announce lag would be its own defect.
      aria-live="polite"
      data-lag-ms={snapshot.lagMs}
    >
      <span className="transcript-stall-notice__dot" aria-hidden="true" />
      <span className="transcript-stall-notice__label">{describe(snapshot)}</span>
    </div>
  )
}
