/**
 * Resolve a receipt's span chatId for §1.1 control actions whose TARGET_RULES
 * kind is not `thread`. Approval and question ids are thread-resolvable from
 * the pending-interaction registry at receipt *begin* (before settle).
 */

export function hostNodeReceiptSpanChatId(
  interactions: {
    listPending(): readonly { id: string; kind: string; threadId: string }[]
  },
  record: { target: { kind: string; id?: string } }
): string | undefined {
  const kind = record.target.kind
  if (kind !== 'approval' && kind !== 'question') return undefined
  const id = record.target.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const entry = interactions
    .listPending()
    .find((candidate) => candidate.id === id && candidate.kind === kind)
  const threadId = entry?.threadId
  return typeof threadId === 'string' && threadId.trim().length > 0 ? threadId.trim() : undefined
}
