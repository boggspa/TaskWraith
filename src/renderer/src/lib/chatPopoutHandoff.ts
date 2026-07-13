import {
  normalizeChatPopoutRoundExpansion,
  normalizeChatPopoutScrollState,
  type ChatPopoutRoundExpansionSnapshot,
  type ChatPopoutScrollState
} from '../../../shared/chatPopoutTransfer'

export interface ChatPopoutHandoffState {
  draft?: string
  scrollState?: ChatPopoutScrollState
  roundExpansion?: ChatPopoutRoundExpansionSnapshot
  writtenAt: number
}

export const CHAT_POPOUT_HANDOFF_PREFIX = 'taskwraith.chatPopoutHandoff.'

export function getInitialChatPopoutChatId(search?: string): string {
  const query =
    typeof search === 'string'
      ? search
      : typeof window === 'undefined'
        ? ''
        : window.location.search
  if (!query) return ''
  const params = new URLSearchParams(query)
  return params.get('popout') === 'chat' ? params.get('chat') || '' : ''
}

export function chatPopoutHandoffKey(chatId: string): string {
  return `${CHAT_POPOUT_HANDOFF_PREFIX}${chatId}`
}

export function serializeChatPopoutHandoff(
  handoff: Omit<ChatPopoutHandoffState, 'writtenAt'>,
  writtenAt = Date.now()
): string {
  const scrollState = normalizeChatPopoutScrollState(handoff.scrollState)
  const roundExpansion = normalizeChatPopoutRoundExpansion(handoff.roundExpansion)
  return JSON.stringify({
    ...(typeof handoff.draft === 'string' ? { draft: handoff.draft } : {}),
    ...(scrollState ? { scrollState } : {}),
    ...(roundExpansion ? { roundExpansion } : {}),
    writtenAt
  })
}

export function parseChatPopoutHandoffPayload(
  raw: string,
  fallbackWrittenAt = Date.now()
): ChatPopoutHandoffState | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const scrollState = normalizeChatPopoutScrollState(record.scrollState)
    const roundExpansion = normalizeChatPopoutRoundExpansion(record.roundExpansion)
    return {
      ...(typeof record.draft === 'string' ? { draft: record.draft } : {}),
      ...(scrollState ? { scrollState } : {}),
      ...(roundExpansion ? { roundExpansion } : {}),
      writtenAt: typeof record.writtenAt === 'number' ? record.writtenAt : fallbackWrittenAt
    }
  } catch {
    return null
  }
}

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function writeChatPopoutHandoff(
  chatId: string,
  handoff: Omit<ChatPopoutHandoffState, 'writtenAt'>
): void {
  if (!chatId) return
  try {
    getStorage()?.setItem(chatPopoutHandoffKey(chatId), serializeChatPopoutHandoff(handoff))
  } catch {
    // Best-effort only. Transcript/run state still lives on the chat record.
  }
}

export function readChatPopoutHandoff(chatId: string): ChatPopoutHandoffState | null {
  if (!chatId) return null
  const key = chatPopoutHandoffKey(chatId)
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    storage.removeItem(key)
    return parseChatPopoutHandoffPayload(raw)
  } catch {
    storage.removeItem(key)
    return null
  }
}

export function listChatPopoutHandoffChatIds(): string[] {
  const storage = getStorage()
  if (!storage) return []
  try {
    const chatIds: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && key.startsWith(CHAT_POPOUT_HANDOFF_PREFIX)) {
        chatIds.push(key.slice(CHAT_POPOUT_HANDOFF_PREFIX.length))
      }
    }
    return chatIds
  } catch {
    return []
  }
}
