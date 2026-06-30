export type PlanSurfaceChatKind = 'ensemble' | 'single' | string | null | undefined

export type EnsemblePlanOwnerInput = {
  chatKind?: PlanSurfaceChatKind
  bossmanParticipantId?: string | null
  fallbackOwnerParticipantId?: string | null
}

export type ProposedPlanCardPolicyInput = EnsemblePlanOwnerInput & {
  messageParticipantId?: string | null
  isPlanMode?: boolean
  hasExplicitProposedPlanBlock?: boolean
}

const cleanId = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveEnsemblePlanOwner(input: EnsemblePlanOwnerInput): string | null {
  if (input.chatKind !== 'ensemble') return null
  return cleanId(input.bossmanParticipantId) || cleanId(input.fallbackOwnerParticipantId)
}

export function shouldSurfaceProposedPlanCard(input: ProposedPlanCardPolicyInput): boolean {
  if (!input.isPlanMode && !input.hasExplicitProposedPlanBlock) return false
  if (input.chatKind !== 'ensemble') return true

  const ownerId = resolveEnsemblePlanOwner(input)
  if (!ownerId) return false
  return cleanId(input.messageParticipantId) === ownerId
}
