/**
 * Send affordance for peer thread messages (S7, send half).
 *
 * Thin over `ThreadMessageSendFormModel`: every decision that could surprise the
 * user — whether send is available, the two warnings, the outcome wording — is in
 * the model, which is testable. This file is layout plus the effects.
 *
 * Two things it does that are not cosmetic:
 *
 *  - It mints ONE idempotency key per composed message and reuses it across
 *    retries, clearing it only after a send is accepted. A double-click or a retry
 *    after a transient failure therefore cannot queue the same message twice — the
 *    disabled button is the first guard and the key is the one that actually holds.
 *  - Wake is off by default and is described by its effect on the other thread.
 *    Defaulting it on, or labelling it "urgent", would make an unattended run in
 *    someone else's thread the path of least resistance.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  threadMessageSendFormState,
  threadMessageSendOutcomeText,
  type ThreadMessageSendTarget
} from './ThreadMessageSendFormModel'
import { MAX_THREAD_MESSAGE_CHARS } from '../../../shared/threadMessage'

export interface ThreadMessageSendFormProps {
  fromChatId: string
  /** Loads addressable threads. Wire to window.api.threadMessageTargets. */
  loadTargets: (fromChatId: string) => Promise<ThreadMessageSendTarget[]>
  /** Wire to window.api.sendThreadMessage. */
  send: (payload: {
    fromChatId: string
    toChatId: string
    message: string
    wake?: boolean
    idempotencyKey?: string
  }) => Promise<{ ok: boolean; outcome?: string; error?: string }>
  /** Stable per composed message; the caller supplies it so tests stay deterministic. */
  createIdempotencyKey: () => string
  onSent?: (toChatId: string) => void
}

export function ThreadMessageSendForm({
  fromChatId,
  loadTargets,
  send,
  createIdempotencyKey,
  onSent
}: ThreadMessageSendFormProps) {
  const [targets, setTargets] = useState<ThreadMessageSendTarget[]>([])
  const [selectedChatId, setSelectedChatId] = useState('')
  const [message, setMessage] = useState('')
  const [wake, setWake] = useState(false)
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState<{ ok: boolean; outcome?: string; error?: string } | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadTargets(fromChatId)
      .then((next) => {
        if (!cancelled) setTargets(next)
      })
      .catch(() => {
        if (!cancelled) setTargets([])
      })
    return () => {
      cancelled = true
    }
  }, [fromChatId, loadTargets])

  const state = useMemo(
    () => threadMessageSendFormState({ targets, selectedChatId, message, wake, sending }),
    [targets, selectedChatId, message, wake, sending]
  )
  const outcome = reply ? threadMessageSendOutcomeText(reply) : null

  async function submit(): Promise<void> {
    if (!state.canSend) return
    // Reuse the key across retries of the SAME composed message, so a retry after a
    // transient failure is recognised rather than queued again.
    const key = idempotencyKey ?? createIdempotencyKey()
    setIdempotencyKey(key)
    setSending(true)
    setReply(null)
    try {
      const result = await send({
        fromChatId,
        toChatId: selectedChatId,
        message,
        ...(wake ? { wake: true } : {}),
        idempotencyKey: key
      })
      setReply(result)
      if (result.ok) {
        setMessage('')
        setWake(false)
        setIdempotencyKey(null)
        onSent?.(selectedChatId)
      }
    } catch (error) {
      setReply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="thread-message-send">
      <label className="thread-message-send-row">
        <span className="thread-message-send-label">Send to</span>
        <select
          className="thread-message-send-select"
          value={selectedChatId}
          disabled={targets.length === 0}
          onChange={(event) => setSelectedChatId(event.target.value)}
        >
          <option value="">Choose a thread…</option>
          {targets.map((target) => (
            <option key={target.chatId} value={target.chatId}>
              {target.crossWorkspace ? `${target.title} (other workspace)` : target.title}
            </option>
          ))}
        </select>
      </label>

      <textarea
        className="thread-message-send-body"
        value={message}
        maxLength={MAX_THREAD_MESSAGE_CHARS + 1}
        placeholder="Say who you are and what you need — the other thread sees your title, not your context."
        onChange={(event) => setMessage(event.target.value)}
      />

      {state.showCounter ? (
        <div
          className="thread-message-send-counter"
          data-over={state.overBudget ? 'true' : 'false'}
        >
          {state.remainingChars} characters left
        </div>
      ) : null}

      <label className="thread-message-send-wake">
        <input type="checkbox" checked={wake} onChange={(event) => setWake(event.target.checked)} />
        <span>Start a turn there now</span>
      </label>

      {state.wakeWarning ? (
        <div className="thread-message-send-warning">{state.wakeWarning}</div>
      ) : null}
      {state.crossWorkspaceWarning ? (
        <div className="thread-message-send-warning">{state.crossWorkspaceWarning}</div>
      ) : null}

      <button
        type="button"
        className="thread-message-send-button"
        disabled={!state.canSend}
        title={state.blockedReason}
        onClick={() => void submit()}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>

      {outcome ? (
        <div className="thread-message-send-outcome" data-tone={outcome.tone}>
          {outcome.text}
        </div>
      ) : null}
    </div>
  )
}
