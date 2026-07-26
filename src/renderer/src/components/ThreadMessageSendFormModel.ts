/**
 * Send-form logic for peer thread messages (S7, send half).
 *
 * Separated from the view because the renderer test setup renders to static markup
 * and cannot click — so validation, the two warnings, and the outcome wording are
 * only testable as a model. They are also the parts worth testing: each one exists
 * to stop the user being surprised by something the gate will do.
 *
 *  - CROSS-WORKSPACE is warned about BEFORE the send, which is the whole reason
 *    `thread-message:targets` reports the flag per candidate. Discovering it from an
 *    approval prompt after hitting send is a worse experience and teaches people to
 *    click through prompts.
 *  - WAKE is described in terms of what it does to the other thread — it starts a
 *    turn there — rather than as a checkbox label like "urgent".
 *  - OUTCOMES are distinguished, because a user who cannot tell "that thread's
 *    queue is full" from "that thread is gone" retries the wrong thing.
 */

import { MAX_THREAD_MESSAGE_CHARS } from '../../../shared/threadMessage'

/** Warn while there is still room to shorten, not only once it is too late. */
export const THREAD_MESSAGE_REMAINING_WARN_CHARS = 500

export interface ThreadMessageSendTarget {
  chatId: string
  title: string
  workspaceId: string | null
  crossWorkspace: boolean
}

export interface ThreadMessageSendFormInput {
  targets: readonly ThreadMessageSendTarget[]
  selectedChatId: string
  message: string
  wake: boolean
  sending: boolean
}

export interface ThreadMessageSendFormState {
  canSend: boolean
  /** Why send is unavailable, for a disabled-button title. Empty when it is. */
  blockedReason: string
  remainingChars: number
  overBudget: boolean
  /** True near or past the cap, so the counter can be surfaced. */
  showCounter: boolean
  /** Set when the chosen target is in another workspace. */
  crossWorkspaceWarning: string
  /** Set when wake is checked, describing the effect on the other thread. */
  wakeWarning: string
  selectedTitle: string
}

export function threadMessageSendFormState(
  input: ThreadMessageSendFormInput
): ThreadMessageSendFormState {
  const selected = input.targets.find((target) => target.chatId === input.selectedChatId) || null
  const trimmed = input.message.trim()
  const remainingChars = MAX_THREAD_MESSAGE_CHARS - input.message.length
  const overBudget = remainingChars < 0

  const blockedReason = input.sending
    ? 'Sending…'
    : input.targets.length === 0
      ? 'There is no other thread to message.'
      : !selected
        ? 'Choose a thread to message.'
        : !trimmed
          ? 'Write a message first.'
          : overBudget
            ? `That message is ${Math.abs(remainingChars)} characters over the limit.`
            : ''

  return {
    canSend: blockedReason === '',
    blockedReason,
    remainingChars,
    overBudget,
    showCounter: remainingChars <= THREAD_MESSAGE_REMAINING_WARN_CHARS,
    crossWorkspaceWarning:
      selected && selected.crossWorkspace
        ? `“${selected.title}” is in another workspace, so this send needs your approval.`
        : '',
    wakeWarning: input.wake
      ? selected
        ? `“${selected.title}” will start a turn as soon as this arrives, instead of waiting for its next one.`
        : 'The target thread will start a turn as soon as this arrives.'
      : '',
    selectedTitle: selected?.title || ''
  }
}

export interface ThreadMessageSendReply {
  ok: boolean
  outcome?: string
  error?: string
}

/**
 * What to tell the user after a send. Mirrors the wording the MCP tool returns to
 * an agent, so the two paths describe the same states the same way.
 */
export function threadMessageSendOutcomeText(reply: ThreadMessageSendReply): {
  tone: 'ok' | 'warn' | 'error'
  text: string
} {
  if (reply.ok) return { tone: 'ok', text: 'Sent. It arrives on that thread’s next turn.' }
  switch (reply.outcome) {
    case 'duplicate':
      return { tone: 'warn', text: 'That message is already queued — it was not sent twice.' }
    case 'already-delivered':
      return { tone: 'warn', text: 'That message was already delivered — it was not re-sent.' }
    case 'inbox-full':
      return {
        tone: 'warn',
        text: 'That thread’s inbox is full. Wait for it to take a turn, then try again.'
      }
    case 'unknown-target':
      return { tone: 'error', text: 'That thread no longer exists.' }
    default:
      return { tone: 'error', text: reply.error || 'That message could not be sent.' }
  }
}
