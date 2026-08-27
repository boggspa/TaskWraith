export type PromptSessionDeliveryMode = 'cold' | 'persistent' | 'repeat' | 'skip'

export interface PromptSessionBlockPlan {
  state: 'applied' | 'inherited' | 'omitted'
  body?: string
  /** Persist only after the provider admits the run. */
  receiptValue?: string
  reason?: string
}

/**
 * Classify whether stable prompt context survives this provider turn.
 *
 * `resumeSessionId` alone is not enough: several ACP/CLI lanes retain a token
 * while opening a fresh provider context, and Pi persists without exposing one.
 */
export function resolvePromptSessionDeliveryMode(input: {
  provider: string
  resumeSessionId?: string | null
  nativeSessionResume?: boolean
  hostFedContextTurn: boolean
  conversationalTurn?: boolean
}): PromptSessionDeliveryMode {
  if (input.conversationalTurn) return 'skip'
  const resumeSessionId = String(input.resumeSessionId || '').trim()
  if (
    input.hostFedContextTurn ||
    input.provider === 'antigravity' ||
    (input.provider === 'gemini' && resumeSessionId.startsWith('api://'))
  ) {
    return 'repeat'
  }
  if (input.provider === 'pi' || input.nativeSessionResume || resumeSessionId) {
    return 'persistent'
  }
  return 'cold'
}

/** Plan one stable/digest-keyed block without confusing composition with proof
 * of delivery. A returned receipt is only a candidate until run_started. */
export function planPromptSessionBlock(input: {
  mode: PromptSessionDeliveryMode
  provider: string
  currentValue?: string | null
  appliedValue?: string | null
  appliedProvider?: string | null
  body?: string | null
  removalBody?: string | null
}): PromptSessionBlockPlan {
  const currentValue = typeof input.currentValue === 'string' ? input.currentValue.trim() : ''
  if (input.mode === 'skip' || !currentValue) return { state: 'omitted' }

  const body = typeof input.body === 'string' ? input.body.trim() : ''
  const appliedValue =
    input.appliedProvider === input.provider && typeof input.appliedValue === 'string'
      ? input.appliedValue.trim()
      : ''

  if (body) {
    if (input.mode === 'persistent' && appliedValue === currentValue) {
      return {
        state: 'inherited',
        reason: 'matching provider-session receipt'
      }
    }
    return {
      state: 'applied',
      body,
      ...(input.mode === 'repeat' ? {} : { receiptValue: currentValue }),
      reason:
        input.mode === 'repeat'
          ? 'provider context is host-fed on this turn'
          : input.mode === 'cold'
            ? 'fresh provider session'
            : appliedValue
              ? 'context changed since the last admitted delivery'
              : 'provider session has no matching receipt'
    }
  }

  if (currentValue !== 'none') return { state: 'omitted' }
  if (input.mode === 'persistent' && appliedValue === 'none') {
    return { state: 'inherited', reason: 'matching empty-context receipt' }
  }
  if (input.mode === 'persistent' && appliedValue && input.removalBody?.trim()) {
    return {
      state: 'applied',
      body: input.removalBody.trim(),
      receiptValue: 'none',
      reason: 'previous provider-session context was removed'
    }
  }
  if (input.mode === 'cold' && appliedValue && appliedValue !== 'none') {
    return {
      state: 'omitted',
      receiptValue: 'none',
      reason: 'fresh provider session has no removed context to revoke'
    }
  }
  return { state: 'omitted' }
}
