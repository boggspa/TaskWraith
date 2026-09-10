import { catalogueChatListItem } from '../main/store/ThreadCatalogueMirror'
import type { ChatListItem, ChatMessage, ChatRecord, ChatRun } from '../main/store/types'
import type { ThreadCatalogueReadQuery } from '../shared/threadCatalogueProtocol'
import type { ThreadCatalogueOpenResult } from '../main/store/ThreadCatalogueClient'
import type {
  ThreadIndexedObject,
  ThreadIndexedObjectKind
} from '../main/store/ThreadCatalogueDatabase'
import type { ChatShell, TranscriptPage, TranscriptPageRequest } from '../shared/transcriptPage'
import { estimateJsonishBytes } from '../shared/transcriptPage'

type Invoke = (channel: string, ...args: unknown[]) => Promise<any>

/** Large JSON is reconstructed in the requesting renderer, never Electron main. */
export function createThreadCatalogueReads(invoke: Invoke) {
  const query = async <T>(q: ThreadCatalogueReadQuery): Promise<T> => {
    const reply = await invoke('thread-catalogue:read', q)
    if (!reply.available) throw new Error('History catalogue is unavailable')
    return reply.data as T
  }
  const open = async (chatId: string, mode: 'record' | 'pages' | 'runs') =>
    invoke('thread-catalogue:read', { method: 'open', chatId, mode }) as Promise<{
      available: boolean
      data: ThreadCatalogueOpenResult | null
    }>
  const resolve = async <T>(leaseId: string, item: ThreadIndexedObject): Promise<T> => {
    if (item.kind === 'inline') return item.value as T
    const bytes = new Uint8Array(item.reference.byteLength)
    let offset = 0
    while (offset < bytes.byteLength) {
      const chunk = await query<Uint8Array | null>({
        method: 'chunk',
        leaseId,
        reference: item.reference,
        offset
      })
      if (!chunk?.byteLength || offset + chunk.byteLength > bytes.byteLength)
        throw new Error('History object is incomplete')
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    if (hex !== item.reference.sha256) throw new Error('History object changed during reading')
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  }
  /**
   * Releasing a lease is best-effort cleanup. Awaiting it bare inside a
   * `finally` meant a failed release REPLACED a completed read's value with
   * its own rejection -- turning a successful load into a blank surface.
   */
  const releaseLease = async (leaseId: string): Promise<void> => {
    try {
      await query({ method: 'release', leaseId })
    } catch {
      // The main-side registry expires leases on its own schedule.
    }
  }
  const one = async <T>(
    leaseId: string,
    kind: ThreadIndexedObjectKind,
    ordinal = 0
  ): Promise<T> => {
    const objects = await query<ThreadIndexedObject[]>({
      method: 'objects',
      leaseId,
      kind,
      before: ordinal + 1,
      ...(ordinal > 0 ? { after: ordinal - 1 } : {}),
      maxObjects: 1
    })
    if (!objects?.length) throw new Error('History object is unavailable')
    return resolve<T>(leaseId, objects[0])
  }
  const reads = {
    async getChatList(workspaceId?: string): Promise<ChatListItem[]> {
      const rows = new Map<string, ChatListItem>()
      let before: { updatedAt: number; chatId: string } | null = null
      do {
        const reply = await invoke('thread-catalogue:read', {
          method: 'list',
          ...(workspaceId ? { workspaceId } : {}),
          ...(before ? { before } : {}),
          limit: 100
        })
        if (!reply.available) return invoke('get-chat-list', workspaceId)
        const page = reply.data as {
          entries: Array<{ projection: ThreadCatalogueOpenResult['entry']['projection'] }>
          next: { updatedAt: number; chatId: string } | null
        }
        for (const { projection } of page.entries)
          rows.set(projection.summary.chatId, catalogueChatListItem(projection))
        before = page.next
      } while (before)
      return [...rows.values()]
    },
    async getChatRunSummaries(workspaceId?: string): Promise<ChatListItem[]> {
      const chats = await reads.getChatList(workspaceId)
      for (const chat of chats) {
        const reply = await open(chat.appChatId, 'runs')
        if (!reply.available) return invoke('get-chat-list', workspaceId)
        if (!reply.data) continue
        const { leaseId } = reply.data
        try {
          const summaries: NonNullable<ChatListItem['runsSummary']> = []
          let after: number | undefined
          for (;;) {
            const page = await query<ThreadIndexedObject[] | null>({
              method: 'objects',
              leaseId,
              kind: 'run-summary',
              direction: 'newer',
              ...(after === undefined ? {} : { after }),
              maxObjects: 100,
              maxBytes: 2 * 1024 * 1024
            })
            if (!page) throw new Error('Run summary history is incomplete')
            if (!page.length) break
            for (const item of page) {
              if (item.kind !== 'inline') throw new Error('Run summary exceeds its metadata budget')
              summaries.push(item.value as NonNullable<ChatListItem['runsSummary']>[number])
              after = item.ordinal
            }
          }
          chat.runsSummary = summaries
        } finally {
          await releaseLease(leaseId)
        }
      }
      return chats
    },
    async getTranscriptMessage(chatId: string, messageId: string): Promise<ChatMessage | null> {
      const reply = await open(chatId, 'pages')
      if (!reply.available || !reply.data) return null
      const { leaseId } = reply.data
      try {
        const ordinal = await query<number | null>({
          method: 'ordinal',
          leaseId,
          kind: 'message',
          recordId: messageId
        })
        return ordinal === null ? null : await one<ChatMessage>(leaseId, 'message', ordinal)
      } finally {
        await releaseLease(leaseId)
      }
    },
    async getChat(chatId: string): Promise<ChatRecord | null> {
      const reply = await open(chatId, 'record')
      if (!reply.available) return invoke('get-chat', chatId)
      // The index is a CACHE over chats/<id>.json, not the record's owner, so
      // a per-chat miss is not proof the chat is gone -- only the canonical
      // read can answer that. An erasure in flight REJECTS out of
      // ensureIndexed rather than resolving null, so this cannot serve back
      // history the user asked to delete.
      if (!reply.data) return invoke('get-chat', chatId)
      try {
        return await one<ChatRecord>(reply.data.leaseId, 'record')
      } finally {
        await releaseLease(reply.data.leaseId)
      }
    },
    async getChatTranscriptPage(request: TranscriptPageRequest): Promise<TranscriptPage | null> {
      const reply = await open(request.chatId, 'pages')
      if (!reply.available) return invoke('get-chat-transcript-page', request)
      // Same reasoning as getChat: a per-chat miss is a cache miss, not proof.
      if (!reply.data) return invoke('get-chat-transcript-page', request)
      const { leaseId, entry } = reply.data
      try {
        const total = entry.projection.summary.messageCount
        const maxMessages = Math.max(1, Math.min(1500, request.maxMessages ?? 1500))
        const maxBytes = Math.max(
          1024,
          Math.min(2 * 1024 * 1024, request.maxBytes ?? 2 * 1024 * 1024)
        )
        let usedBytes = 0
        let shell: ChatShell | undefined
        if (request.includeShell) {
          const items = await query<ThreadIndexedObject[]>({
            method: 'objects',
            leaseId,
            kind: 'shell',
            maxObjects: 1,
            maxBytes: 512 * 1024
          })
          if (items[0]?.kind === 'inline' && items[0].byteLength < maxBytes / 2) {
            shell = items[0].value as ChatShell
            usedBytes += items[0].byteLength
          } else {
            shell = { ...catalogueChatListItem(entry.projection), transcriptPaged: true }
            usedBytes += new TextEncoder().encode(JSON.stringify(shell)).byteLength
          }
        }
        const anchor = request.aroundMessageId || request.beforeMessageId || request.afterMessageId
        const ordinal = anchor
          ? await query<number | null>({
              method: 'ordinal',
              leaseId,
              kind: 'message',
              recordId: anchor
            })
          : null
        if (anchor && ordinal === null) return null
        const newer = Boolean(
          request.afterMessageId && !request.aroundMessageId && !request.beforeMessageId
        )
        const before = request.aroundMessageId
          ? ordinal! + 1
          : request.beforeMessageId
            ? ordinal!
            : total
        let cursor = newer ? ordinal! : before
        let bytes = 0
        let selected: Array<{ ordinal: number; message: ChatMessage }> = []
        while (selected.length < maxMessages) {
          const objects = await query<ThreadIndexedObject[] | null>({
            method: 'objects',
            leaseId,
            kind: 'message',
            ...(newer ? { after: cursor, direction: 'newer' as const } : { before: cursor }),
            maxObjects: maxMessages - selected.length,
            maxBytes: Math.min(2 * 1024 * 1024, maxBytes)
          })
          if (!objects) throw new Error('Transcript page is unavailable')
          if (!objects.length) break
          const ordered = newer ? objects : [...objects].reverse()
          let stop = false
          for (const item of ordered) {
            const size = item.kind === 'inline' ? item.byteLength : item.reference.byteLength
            if (selected.length && bytes + usedBytes + size > maxBytes) {
              stop = true
              break
            }
            if (size > maxBytes - usedBytes - bytes) {
              const preview = (
                item.kind === 'chunked' ? item.preview : item.value
              ) as Partial<ChatMessage> | null
              const message: ChatMessage = {
                id: String(preview?.id ?? `history-${item.ordinal}`),
                role: preview?.role ?? 'system',
                content: String(preview?.content ?? '').slice(0, 1024),
                timestamp: String(preview?.timestamp ?? ''),
                metadata: {
                  kind: 'catalogueDeferredMessage',
                  catalogueChatId: request.chatId,
                  catalogueByteLength: size
                }
              }
              selected.push({ ordinal: item.ordinal, message })
              bytes += new TextEncoder().encode(JSON.stringify(message)).byteLength
              cursor = item.ordinal
              break
            }
            selected.push({
              ordinal: item.ordinal,
              message: await resolve<ChatMessage>(leaseId, item)
            })
            bytes += size
            cursor = item.ordinal
          }
          if (stop || bytes >= maxBytes) break
        }
        selected = selected.sort((a, b) => a.ordinal - b.ordinal)
        const messages = selected.map((item) => item.message)
        const start = selected[0]?.ordinal ?? (newer ? ordinal! + 1 : before)
        const end = selected.length ? selected[selected.length - 1].ordinal + 1 : start
        const runOrdinals = await query<number[]>({
          method: 'page-runs',
          leaseId,
          start,
          end,
          maximum: request.maxRuns
        })
        const runs: ChatRun[] = []
        for (const index of runOrdinals) {
          if (usedBytes + bytes + 16 * 1024 > maxBytes) break
          const values = await query<ThreadIndexedObject[]>({
            method: 'objects',
            leaseId,
            kind: 'run',
            before: index + 1,
            ...(index ? { after: index - 1 } : {}),
            maxObjects: 1,
            maxBytes: Math.min(128 * 1024, maxBytes - bytes - usedBytes)
          })
          const value = values[0]
          if (!value) break
          if (value.kind === 'inline') {
            runs.push(value.value as ChatRun)
            usedBytes += value.byteLength
          } else {
            const run = await one<ChatRun>(leaseId, 'run-summary', index)
            runs.push(run)
            usedBytes += new TextEncoder().encode(JSON.stringify(run)).byteLength
          }
        }
        return {
          chatId: request.chatId,
          messages,
          runs,
          totalMessageCount: total,
          windowStart: start,
          windowEnd: end,
          estimatedBytes: estimateJsonishBytes(messages),
          hasOlder: start > 0,
          hasNewer: end < total,
          oldestMessageId: messages[0]?.id ?? null,
          newestMessageId: messages.at(-1)?.id ?? null,
          updatedAt: entry.projection.summary.updatedAt,
          ...(shell ? { shell } : {})
        }
      } finally {
        await releaseLease(leaseId)
      }
    }
  }
  return reads
}
