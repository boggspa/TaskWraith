import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ChatService } from '../services/ChatService'
import {
  buildTranscriptPage,
  type ChatShell,
  type TranscriptPage,
  type TranscriptPageRequest
} from '../../shared/transcriptPage'
import type { ChatRecord } from '../store/types'
import type { SenderChatReadScope } from './chatHandlers'

/**
 * Stage 1a — main-authoritative transcript paging.
 *
 * Main still owns the complete canonical transcript; this handler projects
 * one bounded `TranscriptPage` (tail, before/after a cursor, or around a
 * message id) over it. It is additive: the renderer continues to hydrate via
 * `get-chat`, and `ChatRecord.messages` semantics are unchanged. Stage 1b
 * wires the renderer's show-older/show-newer affordances onto this channel.
 */

export interface ChatTranscriptPageHandlersDeps {
  chatService: Pick<ChatService, 'getChat'>
  resolveSenderChatReadScope: (event: IpcMainInvokeEvent) => SenderChatReadScope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalMessageId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined
}

// Same rule as get-chat in chatHandlers.ts: a chat-scoped secondary renderer
// may only page the transcript it owns. (Kept local because chatHandlers.ts is
// outside this lane's write scope; the check is intentionally identical.)
function assertReadableChat(scope: SenderChatReadScope, chatId: string): void {
  if (scope.kind === 'chat' && scope.chatId !== chatId) {
    throw new Error('Renderer does not own this chat read.')
  }
}

function parseTranscriptPageRequest(input: unknown): TranscriptPageRequest | null {
  if (!isRecord(input)) return null
  const chatId = input.chatId
  if (typeof chatId !== 'string' || chatId.length === 0) return null
  const request: TranscriptPageRequest = { chatId }
  const beforeMessageId = optionalMessageId(input.beforeMessageId)
  const afterMessageId = optionalMessageId(input.afterMessageId)
  const aroundMessageId = optionalMessageId(input.aroundMessageId)
  const maxMessages = optionalLimit(input.maxMessages)
  const maxBytes = optionalLimit(input.maxBytes)
  const maxRuns = optionalLimit(input.maxRuns)
  if (beforeMessageId) request.beforeMessageId = beforeMessageId
  if (afterMessageId) request.afterMessageId = afterMessageId
  if (aroundMessageId) request.aroundMessageId = aroundMessageId
  if (maxMessages !== undefined) request.maxMessages = maxMessages
  if (maxBytes !== undefined) request.maxBytes = maxBytes
  if (maxRuns !== undefined) request.maxRuns = maxRuns
  if (input.includeShell === true) request.includeShell = true
  return request
}

/**
 * Stage 1b — the full-chrome shell of a paged chat: the same demote-style
 * spread the renderer's chatByteLru demote uses (kept local because the
 * renderer module is outside this lane's scope). Everything except the
 * transcript arrays is retained — including the FULL ensemble roster with
 * seat briefs, deliberately richer than a chat-list row's lean projection —
 * plus `summaryOnly` (so every existing save fence and summary-mutation
 * escalation works unchanged), counts, the last run, and the
 * `transcriptPaged` marker the renderer uses to treat it as a paged shell.
 */
function buildChatShell(chat: ChatRecord): ChatShell {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  const { messages: _messages, runs: _runs, ...chrome } = chat
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined
  return {
    ...chrome,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: messages.length,
    runCount: runs.length,
    ...(lastRun ? { lastRun } : {}),
    transcriptPaged: true
  }
}

export function registerChatTranscriptPageHandlers(deps: ChatTranscriptPageHandlersDeps): void {
  ipcMain.handle('get-chat-transcript-page', (event, input: unknown): TranscriptPage | null => {
    const scope = deps.resolveSenderChatReadScope(event)
    const request = parseTranscriptPageRequest(input)
    if (!request) throw new Error('Invalid transcript page request.')
    assertReadableChat(scope, request.chatId)
    const chat = deps.chatService.getChat(request.chatId)
    if (!chat) return null
    const page = buildTranscriptPage(chat, request)
    if (page && request.includeShell) page.shell = buildChatShell(chat)
    return page
  })
}
