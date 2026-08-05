/**
 * MCP executor for `thread_message` — one chat handing a message to another (S5).
 *
 * SELF-GATING, like the `tw_recall_*` family: the tool sits in
 * `skipGenericApproval` and routes through `ThreadMessagePermission` instead of
 * the generic `mcpTools` gate. That is deliberate — a generic mcpTools grant must
 * not authorise pushing content into another thread's context, which is why
 * `threadMessage` is its own agentic service.
 *
 * A factory over injected deps so the whole path is unit-testable with no
 * Electron: the host wires posture, prompting, the approval ledger, and the
 * durable inbox.
 *
 * The two things this module refuses on its own account, before any gate:
 *  - `origin` is hardcoded to `'agent'`. A tool call is never a user-composed
 *    message, and the argument does not exist, so it cannot be claimed.
 *  - the sender's display title comes from the STORE's record of the calling
 *    chat, never from tool arguments, so a caller cannot label its message as
 *    coming from a thread the user trusts more.
 */

import type { McpToolExecutionResult } from './McpBridgeRuntime'
import type { ThreadMessageDelivery, ThreadMessageEvent } from '../../shared/threadMessage'
import type { SeatChangeSeatState } from '../../shared/seatChange'
import { createThreadMessageEvent } from '../../shared/threadMessage'
import {
  threadMessageDenialMessage,
  type ThreadMessageGateDecision
} from '../ThreadMessagePermission'
import type { ThreadMessageDeliveryOutcome } from '../ThreadMessageLedger'

export const THREAD_MESSAGE_MCP_TOOL_NAMES = ['thread_message'] as const

export type ThreadMessageMcpToolName = (typeof THREAD_MESSAGE_MCP_TOOL_NAMES)[number]

const THREAD_MESSAGE_TOOL_NAME_SET: ReadonlySet<string> = new Set(THREAD_MESSAGE_MCP_TOOL_NAMES)

export function isThreadMessageMcpToolName(name: string): name is ThreadMessageMcpToolName {
  return THREAD_MESSAGE_TOOL_NAME_SET.has(name)
}

/** Narrow caller context; the provider tool contexts are structurally assignable. */
export interface ThreadMessageToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  scope?: string
}

/** Cheap chat metadata for target resolution — no message bodies. */
export interface ThreadMessageTargetChat {
  chatId: string
  title: string
  workspaceId: string | null
  archived: boolean
}

export interface ThreadMessageToolDeps {
  /** Candidate targets. Bodies are never needed to route a message. */
  listTargetChats: () => readonly ThreadMessageTargetChat[]
  /** The calling chat's own record, or null when the caller is unscoped. */
  resolveCallerChat: (context: ThreadMessageToolContext) => ThreadMessageTargetChat | null
  /**
   * Single decision point. Wired in the host to resolve the sending run's
   * posture, the `threadMessage` policy, remote origin and the elevation grounds,
   * prompt when the decision is `'prompt'`, and write the approval-ledger row
   * whenever `ledgerRequired` is set.
   */
  resolveThreadMessageAccess: (input: {
    context: ThreadMessageToolContext
    parentProvider: string
    crossWorkspace: boolean
    requestedDelivery: ThreadMessageDelivery
    fromChatId: string
    toChatId: string
  }) => Promise<ThreadMessageGateDecision>
  /** Durable enqueue (AppStore.enqueueThreadMessage). */
  enqueueThreadMessage: (event: ThreadMessageEvent) => { outcome: ThreadMessageDeliveryOutcome }
  /** Deterministic id from a caller-supplied nonce (createThreadMessageId). */
  mintThreadMessageId: (fromChatId: string, toChatId: string, nonce: string) => string
  now: () => number
  /** Best-effort UI notify for the receiving chat (sidebar indicator, S7). */
  notifyThreadMessageQueued?: (event: ThreadMessageEvent) => void
  /**
   * The calling seat as configured RIGHT NOW, for the receiving card's "who
   * sent this" header. Resolved in the host, where the chat record and roster
   * live; this module stays free of both.
   *
   * Optional, and returning null is a supported answer rather than a failure —
   * a solo chat has no participant to describe, and the card renders an honest
   * seatless line. What it must never do is guess: an inaccurate seat is worse
   * than no seat, because the reader uses it to decide how much weight to give
   * a relayed message.
   */
  resolveCallerSeat?: (context: ThreadMessageToolContext) => SeatChangeSeatState | null
}

export interface ThreadMessageToolExecutors {
  executeThreadMessageTool: (
    toolName: ThreadMessageMcpToolName,
    rawArgs: unknown,
    context: ThreadMessageToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function jsonResult(value: Record<string, unknown>): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }] }
}

function fail(message: string, extra: Record<string, unknown> = {}): McpToolExecutionResult {
  const value = { ok: false, tool: 'thread_message', error: message, ...extra }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

/**
 * Human-facing outcome text. `unknown-target` and `inbox-full` are reported as
 * distinct, actionable states rather than a generic failure — a caller that
 * cannot tell "wrong id" from "the queue is full" will retry the wrong thing.
 */
function outcomeMessage(outcome: ThreadMessageDeliveryOutcome, toChatId: string): string {
  switch (outcome) {
    case 'accepted':
      return `Queued for thread ${toChatId}. It enters that thread's context on its next turn.`
    case 'duplicate':
      return 'That exact message is already queued (same idempotency key); it was not queued twice.'
    case 'already-delivered':
      return 'That message was already delivered to the target thread; it was not re-sent.'
    case 'inbox-full':
      return "The target thread's inbox is full. Wait for it to take a turn, then retry."
    case 'unknown-target':
      return 'No such thread. Pass an exact chat id, or a title that matches exactly one thread.'
    case 'wrong-destination':
      return 'The message did not match the destination inbox and was not queued.'
  }
}

export function createThreadMessageToolExecutors(
  deps: ThreadMessageToolDeps
): ThreadMessageToolExecutors {
  /**
   * Resolve `to` to exactly one chat. An exact id wins; otherwise a
   * case-insensitive title must be unambiguous. An ambiguous title is an ERROR
   * listing the candidates rather than a guess — silently picking one would send
   * a message to a thread the caller did not mean.
   */
  function resolveTarget(
    to: string,
    callerChatId: string
  ): { chat: ThreadMessageTargetChat } | { error: McpToolExecutionResult } {
    const chats = deps.listTargetChats().filter((chat) => chat.chatId !== callerChatId)
    const byId = chats.find((chat) => chat.chatId === to)
    if (byId) return { chat: byId }

    const wanted = to.toLowerCase()
    const byTitle = chats.filter(
      (chat) => !chat.archived && chat.title.trim().toLowerCase() === wanted
    )
    if (byTitle.length === 1) return { chat: byTitle[0] }
    if (byTitle.length > 1) {
      return {
        error: fail(`"${to}" matches ${byTitle.length} threads. Pass one of these chat ids.`, {
          candidates: byTitle.map((chat) => ({ chatId: chat.chatId, title: chat.title }))
        })
      }
    }
    return {
      error: fail(
        `No thread matches "${to}". Pass an exact chat id, or a title that matches exactly one thread.`,
        { outcome: 'unknown-target' }
      )
    }
  }

  async function executeSend(
    rawArgs: unknown,
    context: ThreadMessageToolContext,
    parentProvider: string
  ): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    const to = asTrimmedString(args.to)
    const body = typeof args.message === 'string' ? args.message : ''
    if (!to) return fail('`to` is required — a target chat id, or an exact thread title.')
    if (!body.trim()) return fail('`message` is required and must not be empty.')

    const caller = deps.resolveCallerChat(context)
    if (!caller) {
      return fail('This chat is not addressable, so it cannot send thread messages.')
    }

    const resolved = resolveTarget(to, caller.chatId)
    if ('error' in resolved) return resolved.error
    const target = resolved.chat

    // Unscoped on either side counts as crossing: an unscoped chat is not inside
    // the caller's workspace boundary, so it must not inherit same-workspace trust.
    const crossWorkspace =
      !caller.workspaceId || !target.workspaceId || caller.workspaceId !== target.workspaceId
    const requestedDelivery: ThreadMessageDelivery = args.wake === true ? 'wake' : 'queue'

    const decision = await deps.resolveThreadMessageAccess({
      context,
      parentProvider,
      crossWorkspace,
      requestedDelivery,
      fromChatId: caller.chatId,
      toChatId: target.chatId
    })
    if (decision.verdict !== 'allow') {
      return jsonResult({
        ok: true,
        tool: 'thread_message',
        queued: false,
        blocked: true,
        reason: decision.reason,
        message: threadMessageDenialMessage(decision.reason)
      })
    }

    // Idempotency: a caller-supplied key, else the run id. Two deliberate messages
    // in one run should differ, so an explicit key is how a caller says "this is
    // the same send, retried".
    const nonce =
      asTrimmedString(args.idempotencyKey) || `${context.appRunId || 'no-run'}:${deps.now()}`
    const event = createThreadMessageEvent({
      id: deps.mintThreadMessageId(caller.chatId, target.chatId, nonce),
      fromChatId: caller.chatId,
      // From the store's record of the calling chat — never from tool arguments,
      // so a caller cannot present itself as a thread the user trusts more.
      fromChatTitle: caller.title,
      toChatId: target.chatId,
      // Hardcoded: a tool call is not a user-composed message, and there is no
      // argument for this, so it cannot be claimed.
      origin: 'agent',
      body,
      requestedDelivery,
      createdAt: deps.now(),
      // Captured at SEND time, from the store — never from tool arguments, for
      // the same reason as the title above, and never resolved later from the
      // chat id, which would let a reconfiguration of this thread rewrite what
      // the reader is told about a message it already received.
      seat: deps.resolveCallerSeat?.(context) ?? undefined
    })
    if (!event) {
      return fail('The message could not be built (empty after sanitising, or self-addressed).')
    }

    const { outcome } = deps.enqueueThreadMessage(event)
    if (outcome === 'accepted') deps.notifyThreadMessageQueued?.(event)
    return jsonResult({
      ok: true,
      tool: 'thread_message',
      queued: outcome === 'accepted',
      outcome,
      toChatId: target.chatId,
      toChatTitle: target.title,
      messageId: event.id,
      requestedDelivery,
      crossWorkspace,
      ...(event.truncated ? { truncated: true } : {}),
      message: outcomeMessage(outcome, target.chatId)
    })
  }

  async function executeThreadMessageTool(
    toolName: ThreadMessageMcpToolName,
    rawArgs: unknown,
    context: ThreadMessageToolContext,
    parentProvider: string
  ): Promise<McpToolExecutionResult> {
    try {
      switch (toolName) {
        case 'thread_message':
          return await executeSend(rawArgs, context, parentProvider)
        default:
          // No terminal else anywhere in this dispatcher: a missing branch would
          // return a silent empty success, which reads as a delivered message.
          return fail(`Unknown thread-message tool "${toolName}".`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  return { executeThreadMessageTool }
}
