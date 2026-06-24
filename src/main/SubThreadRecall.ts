/*
 * SubThreadRecall — Phase J2 resolver for `delegate_to_subthread`
 * recall mode.
 *
 * The MCP `delegate_to_subthread` tool accepts an optional
 * `subThreadId` argument. When set, the calling agent is asking the
 * tool to send its prompt as a follow-up turn to an existing
 * sub-thread it spawned earlier (whose id was returned in the
 * tool_result of the original call). This module decides whether
 * recall is valid:
 *
 *  - `{ mode: 'spawn' }` — no `subThreadId` was supplied; the caller
 *    should spawn a fresh sub-thread as before.
 *
 *  - `{ mode: 'recall', chat, resumeSessionId }` — the supplied id
 *    resolves to a chat that's a sub-thread of the calling parent, on
 *    the same target provider, not archived, and has a linked provider
 *    session to resume. The caller dispatches a new turn against that
 *    chat and injects `resumeSessionId` as `providerSessionId`.
 *
 *  - `{ mode: 'error', message }` — the supplied id was missing /
 *    wrong parent / wrong provider / archived. The caller returns
 *    the message as the tool_result so the agent learns what went
 *    wrong (no run is dispatched).
 *
 * Pure function — no IPC, no broker, no state. The caller hands in a
 * `chatLookup` closure so this stays test-friendly without spinning
 * up the full AppStore.
 */

import type { ChatRecord, ProviderId } from './store/types'

export interface SubThreadRecallRequest {
  subThreadId?: string | null
  parentChatId: string
  targetProvider: ProviderId
}

export type SubThreadRecallResolution =
  | { mode: 'spawn' }
  | { mode: 'recall'; chat: ChatRecord; resumeSessionId: string }
  | { mode: 'error'; message: string }

export type SubThreadRecallChatLookup = (chatId: string) => ChatRecord | undefined

function isActiveRunStatus(status: unknown): boolean {
  return (
    status === 'running' ||
    status === 'queued' ||
    status === 'starting' ||
    status === 'cancelling' ||
    status === 'steer_promoting' ||
    status === 'active' ||
    status === 'paused'
  )
}

function isSubThreadChat(chat: ChatRecord): boolean {
  return Boolean(
    chat.parentChatId &&
      (chat.parentChatRelation === undefined || chat.parentChatRelation === 'subThread')
  )
}

export function getSubThreadResumeSessionId(chat: ChatRecord): string | undefined {
  const value =
    chat.provider === 'gemini'
      ? chat.linkedGeminiSessionId || chat.linkedProviderSessionId
      : chat.linkedProviderSessionId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function resolveSubThreadRecall(
  request: SubThreadRecallRequest,
  lookup: SubThreadRecallChatLookup
): SubThreadRecallResolution {
  const requestedId = typeof request.subThreadId === 'string' ? request.subThreadId.trim() : ''
  if (!requestedId) {
    return { mode: 'spawn' }
  }
  const chat = lookup(requestedId)
  if (!chat) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: subThreadId "${requestedId}" does not match any TaskWraith chat record. ` +
        `Recall requires the id returned by an earlier delegate_to_subthread tool_result; ` +
        `the id is stable for the lifetime of the sub-thread.`
    }
  }
  if (chat.archived) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: sub-thread "${requestedId}" is archived. ` +
        `Spawn a new sub-thread (omit subThreadId) or unarchive the existing one in TaskWraith.`
    }
  }
  if (!isSubThreadChat(chat) || !chat.parentChatId || chat.parentChatId !== request.parentChatId) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: sub-thread "${requestedId}" belongs to a different parent chat ` +
        `(${chat.parentChatId || 'no parent'}), not the chat issuing this delegation. ` +
        `Recall only works for sub-threads YOU spawned from THIS parent.`
    }
  }
  if (chat.provider !== request.targetProvider) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: sub-thread "${requestedId}" runs ${chat.provider}, ` +
        `but this call requested provider="${request.targetProvider}". ` +
        `Recall requires the provider to match the existing sub-thread.`
    }
  }
  const latestRun = [...(chat.runs || [])].reverse()[0]
  if (isActiveRunStatus(latestRun?.status)) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: sub-thread "${requestedId}" is still ${latestRun?.status}. ` +
        `Recall while a sub-thread is running is rejected in v1 to avoid task inversions. ` +
        `Wait for it to complete, inspect lifecycle with list_subthreads/read_subthread_result, then retry.`
    }
  }
  const resumeSessionId = getSubThreadResumeSessionId(chat)
  if (!resumeSessionId) {
    return {
      mode: 'error',
      message:
        `delegate_to_subthread: sub-thread "${requestedId}" does not have a resumable ` +
        `${chat.provider || request.targetProvider} provider session yet. ` +
        `Recall is deterministic: wait for the current turn to complete and check ` +
        `list_subthreads/read_subthread_result, or omit subThreadId to spawn a fresh sub-thread.`
    }
  }
  return { mode: 'recall', chat, resumeSessionId }
}
