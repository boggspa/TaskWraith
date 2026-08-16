export interface BlackboardDeleteReceipt {
  ok: true
  tool: 'blackboard_delete'
  removedCount: number
  remainingCount: number
  deletedContentOmitted: true
}

/**
 * Build the model-facing receipt without accepting deleted entries as input.
 * Keeping the API count-only makes it impossible for post bodies, polls, or
 * media metadata to leak back into a tool result during a bulk cleanup.
 */
export function createBlackboardDeleteReceipt(input: {
  removedCount: number
  remainingCount: number
}): BlackboardDeleteReceipt {
  return {
    ok: true,
    tool: 'blackboard_delete',
    removedCount: input.removedCount,
    remainingCount: input.remainingCount,
    deletedContentOmitted: true
  }
}

function nonNegativeCount(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

/** Canonicalize a successful delete result before it crosses the model boundary. */
export function projectBlackboardDeleteResultForModel(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (record.tool !== 'blackboard_delete' || record.ok !== true) return value

  const removedFallback = Array.isArray(record.removed) ? record.removed.length : 0
  return createBlackboardDeleteReceipt({
    removedCount: nonNegativeCount(record.removedCount, removedFallback),
    remainingCount: nonNegativeCount(record.remainingCount, 0)
  })
}
