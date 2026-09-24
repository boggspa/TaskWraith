import { useState } from 'react'
import type { ChatMessage } from '../../../main/store/types'

/** An oversized historical event is loaded only after the user opens it. */
export function DeferredTranscriptMessage({
  message,
  chatId
}: {
  message: ChatMessage
  chatId: string
}): React.JSX.Element {
  const [full, setFull] = useState<ChatMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const size = Number(message.metadata?.catalogueByteLength ?? 0)
  const load = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const value = await window.api.getTranscriptMessage(chatId, message.id)
      if (!value) throw new Error('This message is no longer available.')
      setFull(value)
    } catch {
      setError('The full message could not be loaded. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="transcript-history-page-card">
      <div>{full ? 'Full message' : `Large message · ${(size / (1024 * 1024)).toFixed(1)} MB`}</div>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          maxHeight: 480,
          overflow: 'auto'
        }}
      >
        {full ? full.content || JSON.stringify(full, null, 2) : message.content}
      </pre>
      {full ? (
        <button type="button" onClick={() => setFull(null)}>
          Collapse message
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void load()
          }}
        >
          {busy ? 'Loading…' : 'Load full message'}
        </button>
      )}
      {error && <div role="status">{error}</div>}
    </div>
  )
}
