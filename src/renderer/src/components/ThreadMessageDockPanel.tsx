/**
 * ThreadMessageDockPanel — the right-dock "Peers" surface: this thread's inbound
 * peer thread-messages plus the affordance to send one to another thread.
 *
 * The panel owns the IPC wiring so the composition root does not have to. App.tsx
 * already holds the inbox snapshot (the dock tab badge needs the count), so the
 * snapshot arrives as a prop and there is exactly ONE fetch per chat; targets and
 * sends are reached from here.
 *
 * **The three function props handed to `ThreadMessageSendForm` are module-level on
 * purpose.** That form loads its target list in an effect keyed on
 * `[fromChatId, loadTargets]`. An inline arrow would be a new identity every
 * render, so each resolved fetch would set state, re-render, and refire the
 * effect — an unbounded IPC loop. Module-level functions are referentially stable
 * for the life of the window, which is what that dependency list requires.
 */

import { ThreadMessageIndicator, ThreadMessageInboxPanel } from './ThreadMessageInboxCard'
import { ThreadMessageSendForm } from './ThreadMessageSendForm'
import type { ThreadMessageSendTarget } from './ThreadMessageSendFormModel'
import type { ThreadMessageInboxSnapshot } from '../hooks/useThreadMessageInbox'

interface ThreadMessageWindowApi {
  threadMessageTargets?: (fromChatId: string) => Promise<ThreadMessageSendTarget[]>
  sendThreadMessage?: (payload: {
    fromChatId: string
    toChatId: string
    message: string
    wake?: boolean
    idempotencyKey?: string
  }) => Promise<{ ok: boolean; outcome?: string; messageId?: string; error?: string }>
}

function threadMessageApi(): ThreadMessageWindowApi | undefined {
  return (window as unknown as { api?: ThreadMessageWindowApi }).api
}

/** Stable identity required by the send form's effect — see the module comment. */
export function loadThreadMessageTargets(fromChatId: string): Promise<ThreadMessageSendTarget[]> {
  const api = threadMessageApi()
  if (!api?.threadMessageTargets) return Promise.resolve([])
  return api.threadMessageTargets(fromChatId)
}

/** Stable identity required by the send form — see the module comment. */
export function sendThreadMessageOverIpc(payload: {
  fromChatId: string
  toChatId: string
  message: string
  wake?: boolean
  idempotencyKey?: string
}): Promise<{ ok: boolean; outcome?: string; error?: string }> {
  const api = threadMessageApi()
  if (!api?.sendThreadMessage) {
    return Promise.resolve({ ok: false, error: 'Thread messaging is unavailable in this window.' })
  }
  return api.sendThreadMessage(payload)
}

export function createThreadMessageIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `tm-${uuid}` : `tm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export interface ThreadMessageDockPanelProps {
  chatId: string
  snapshot: ThreadMessageInboxSnapshot
  /** Called after an accepted send, so the host can refresh a stale count. */
  onSent?: (toChatId: string) => void
}

export function ThreadMessageDockPanel({ chatId, snapshot, onSent }: ThreadMessageDockPanelProps) {
  return (
    <div className="thread-message-dock" aria-label="Thread messages panel">
      <div className="thread-message-dock-header">
        <span className="thread-message-dock-title">Thread messages</span>
        <ThreadMessageIndicator summary={snapshot.summary} />
      </div>

      <div className="thread-message-dock-section">
        <ThreadMessageInboxPanel messages={snapshot.pending} />
        {snapshot.pending.length > 0 ? (
          // Says when the inbox drains, because nothing here is a dismiss button:
          // pending messages are handed to the model on the thread's next turn and
          // clear then. Without this the count looks stuck.
          <div className="thread-message-dock-note">
            These are handed to this thread on its next turn, then clear.
          </div>
        ) : null}
      </div>

      <div className="thread-message-dock-section">
        <div className="thread-message-dock-subtitle">Send to another thread</div>
        <ThreadMessageSendForm
          fromChatId={chatId}
          loadTargets={loadThreadMessageTargets}
          send={sendThreadMessageOverIpc}
          createIdempotencyKey={createThreadMessageIdempotencyKey}
          onSent={onSent}
        />
      </div>
    </div>
  )
}
