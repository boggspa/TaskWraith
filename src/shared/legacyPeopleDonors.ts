interface Message {
  id: string
  content?: unknown
  timestamp?: unknown
  metadata?: Record<string, unknown>
}
export type LegacyPeopleTranscriptOp =
  | { op: 'append'; messages: readonly Message[] }
  | { op: 'update'; id: string; message: Message }
  | { op: 'delete' | 'truncateFrom'; id: string }

// Every projected key has a fixed order; no record/runtime module belongs in
// the Host's admission closure just to compare this small structural contract.
const sameInventory = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export interface LegacyDonorChat {
  appChatId?: string
  title?: string
  scope?: string
  chatKind?: string
  parentChatId?: string
  parentChatRelation?: string
  sideChatContext?: unknown
  messages?: readonly Message[]
}

/** The normalized fields actually consumed by the existing migration inventory. */
function inventoryIdentity(chat: LegacyDonorChat) {
  return {
    appChatId: chat.appChatId,
    title: typeof chat.title === 'string' ? chat.title : '',
    scope: chat.scope === 'global' ? 'global' : 'workspace',
    chatKind: chat.chatKind === 'ensemble' ? 'ensemble' : 'single',
    parentChatId: chat.parentChatId || undefined,
    parentChatRelation: chat.parentChatId
      ? chat.parentChatRelation === 'sideChat'
        ? 'sideChat'
        : 'subThread'
      : undefined,
    sideChat: Boolean(
      chat.sideChatContext || (chat.parentChatId && chat.parentChatRelation === 'sideChat')
    )
  }
}
function donorEvidence(message: Message) {
  return {
    id: message.id,
    content: message.content,
    timestamp: message.timestamp,
    metadata: Object.fromEntries(
      ['kind', 'shareId', 'collaboratorId', 'clientMessageId', 'sequence'].map((key) => [
        key,
        message.metadata?.[key]
      ])
    )
  }
}

export function isLegacyPeopleDonor(message: Message | undefined): boolean {
  return (
    message?.metadata?.kind === 'humanCollaboratorComment' ||
    message?.metadata?.kind === 'externalSeatTurn'
  )
}

export function changesLegacyPeopleDonors(
  previous: LegacyDonorChat | null,
  next: LegacyDonorChat
): boolean {
  if (!previous || !sameInventory(inventoryIdentity(previous), inventoryIdentity(next))) return true
  if (previous.messages === next.messages) return false
  const before = (previous?.messages ?? []).filter(isLegacyPeopleDonor).map(donorEvidence)
  const after = (next.messages ?? []).filter(isLegacyPeopleDonor).map(donorEvidence)
  return !sameInventory(before, after)
}

export function transcriptOpsChangeLegacyPeopleDonors(
  previous: LegacyDonorChat,
  ops: readonly LegacyPeopleTranscriptOp[]
): boolean {
  const messages = previous.messages ?? []
  return ops.some((op) => {
    if (op.op === 'append') return op.messages.some(isLegacyPeopleDonor)
    if (op.op === 'truncateFrom') {
      const index = messages.findIndex((message) => message.id === op.id)
      return index >= 0 && messages.slice(index + 1).some(isLegacyPeopleDonor)
    }
    return (
      isLegacyPeopleDonor(messages.find((message) => message.id === op.id)) ||
      (op.op === 'update' && isLegacyPeopleDonor(op.message))
    )
  })
}
