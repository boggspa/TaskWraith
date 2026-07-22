import type { EnsembleParticipant } from './store/types'

export type EnsembleYieldRejectReason =
  | 'unresolved'
  | 'ambiguous'
  | 'fanout_lane_ignored'
  | 'blocked_status'
  | 'hop_limit'
  | 'authority_precedence'
  | 'outside_scope'
  | 'no_active_run'

export type EnsembleYieldRouteAction =
  | 'promoted'
  | 'resummoned'
  | 'background_reserved'
  | 'user'
  | 'hint_applied'

export type EnsembleYieldRoutingResult =
  | { ok: true; targetParticipantId?: string; action: EnsembleYieldRouteAction }
  | {
      ok: false
      reason: Exclude<EnsembleYieldRejectReason, 'no_active_run'>
      target?: string
      suggestedAliases?: string[]
    }

export type EnsembleYieldOutcome =
  | { kind: 'no_active_run' }
  | { kind: 'yielded'; routing?: EnsembleYieldRoutingResult }

export type StoredYieldRouting =
  | { kind: 'user' }
  | {
      kind: 'background'
      targetParticipantId: string
      sourceRunId: string
      prompt: string
    }
  | {
      kind: 'queue'
      action: 'promoted' | 'resummoned' | 'hint_applied'
      targetParticipantId: string
      /** Set when a continuous re-summon reserved its hop during markYielded. */
      continuationReserved?: boolean
    }
  | {
      kind: 'rejected'
      reason: Exclude<EnsembleYieldRejectReason, 'no_active_run'>
      target?: string
    }

export function storedYieldRoutingFromResult(
  routing: EnsembleYieldRoutingResult,
  source: { runId: string; content: string },
  options?: { continuationReserved?: boolean }
): StoredYieldRouting | undefined {
  if (!routing.ok) {
    return { kind: 'rejected', reason: routing.reason, target: routing.target }
  }
  if (routing.action === 'user') return { kind: 'user' }
  if (routing.action === 'background_reserved' && routing.targetParticipantId) {
    return {
      kind: 'background',
      targetParticipantId: routing.targetParticipantId,
      sourceRunId: source.runId,
      prompt: source.content
    }
  }
  if (
    routing.targetParticipantId &&
    (routing.action === 'promoted' ||
      routing.action === 'resummoned' ||
      routing.action === 'hint_applied')
  ) {
    return {
      kind: 'queue',
      action: routing.action,
      targetParticipantId: routing.targetParticipantId,
      ...(options?.continuationReserved ? { continuationReserved: true } : {})
    }
  }
  return undefined
}

export function yieldRejectStatusLine(input: {
  target: string
  reason: Exclude<EnsembleYieldRejectReason, 'no_active_run'>
  suggestedAliases?: string[]
}): string {
  const base = `Yield target "${input.target}" was not routed: ${input.reason}.`
  if (!input.suggestedAliases?.length) return base
  return `${base} Try a unique alias: ${input.suggestedAliases.join(', ')}.`
}

export function yieldRouteSuccessStatusLine(
  action: EnsembleYieldRouteAction,
  displayName: string
): string {
  switch (action) {
    case 'user':
      return `Yielded to the user. Round closed.`
    case 'background_reserved':
      return `Yielded background work to ${displayName}; foreground rotation continues.`
    case 'resummoned':
      return `Routed next: ${displayName} (re-summoned).`
    case 'hint_applied':
      return `Yield hint applied: ${displayName} speaks next.`
    default:
      return `Routed next: ${displayName}.`
  }
}

export function suggestUniqueYieldAliases(matches: EnsembleParticipant[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const participant of matches) {
    for (const alias of [
      participant.role?.trim(),
      participant.model?.trim(),
      participant.id
    ]) {
      if (!alias) continue
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(alias)
    }
  }
  return out.slice(0, 6)
}
