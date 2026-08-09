export interface CanvasPresentationCandidate {
  canvasId: string
  driver: string
  status: string
  presentation?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/** True only for an explicit agent request to present Canvas in the active chat's dock. */
export function isCanvasDockPresentationEvent(value: unknown, activeChatId: string): boolean {
  if (!activeChatId || !isRecord(value)) return false
  if (value.kind !== 'session.opened' || value.chatId !== activeChatId) return false
  return isRecord(value.detail) && value.detail.presentation === 'dock'
}

/** Active embedded presentations that have not yet been adopted by this renderer. */
export function selectUnownedDockPresentations<T extends CanvasPresentationCandidate>(
  summaries: readonly T[],
  rendererOwnedIds: ReadonlySet<string>
): T[] {
  return summaries.filter(
    (summary) =>
      summary.presentation === 'dock' &&
      summary.status === 'active' &&
      (summary.driver === 'web' || summary.driver === 'sketch') &&
      !rendererOwnedIds.has(summary.canvasId)
  )
}
