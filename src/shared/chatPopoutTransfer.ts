export const MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES = 256
export const MAX_CHAT_POPOUT_ROUND_ID_LENGTH = 256
export const MAX_CHAT_POPOUT_ANCHOR_ID_LENGTH = 2048

export interface ChatPopoutScrollState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollRatio: number
  atBottom: boolean
  anchorMessageId?: string
  anchorOffset?: number
}

export interface ChatPopoutRoundExpansionEntry {
  roundId: string
  expanded: boolean
}

export type ChatPopoutRoundExpansionSnapshot = ChatPopoutRoundExpansionEntry[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function normalizeChatPopoutScrollState(value: unknown): ChatPopoutScrollState | undefined {
  if (!isRecord(value)) return undefined
  const scrollTop = Number(value.scrollTop)
  const scrollHeight = Number(value.scrollHeight)
  const clientHeight = Number(value.clientHeight)
  const scrollRatio = Number(value.scrollRatio)
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollRatio)
  ) {
    return undefined
  }

  const anchorMessageId =
    typeof value.anchorMessageId === 'string' &&
    value.anchorMessageId.length > 0 &&
    value.anchorMessageId.length <= MAX_CHAT_POPOUT_ANCHOR_ID_LENGTH
      ? value.anchorMessageId
      : undefined
  const anchorOffset = value.anchorOffset

  return {
    scrollTop: Math.max(0, scrollTop),
    scrollHeight: Math.max(0, scrollHeight),
    clientHeight: Math.max(0, clientHeight),
    scrollRatio: Math.max(0, Math.min(1, scrollRatio)),
    atBottom: Boolean(value.atBottom),
    ...(anchorMessageId ? { anchorMessageId } : {}),
    ...(typeof anchorOffset === 'number' && Number.isFinite(anchorOffset)
      ? { anchorOffset }
      : {})
  }
}

export function normalizeChatPopoutRoundExpansion(
  value: unknown
): ChatPopoutRoundExpansionSnapshot | undefined {
  if (!Array.isArray(value)) return undefined
  const byRoundId = new Map<string, boolean>()
  for (const candidate of value.slice(0, MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES)) {
    if (!isRecord(candidate)) continue
    const roundId = candidate.roundId
    if (
      typeof roundId !== 'string' ||
      roundId.trim().length === 0 ||
      roundId.length > MAX_CHAT_POPOUT_ROUND_ID_LENGTH ||
      typeof candidate.expanded !== 'boolean'
    ) {
      continue
    }
    // Last valid entry wins without exposing object-key/prototype semantics.
    if (byRoundId.has(roundId)) byRoundId.delete(roundId)
    byRoundId.set(roundId, candidate.expanded)
  }
  if (value.length > 0 && byRoundId.size === 0) return undefined
  return Array.from(byRoundId, ([roundId, expanded]) => ({ roundId, expanded }))
}
