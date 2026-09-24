import { getOrderedEnsembleParticipants } from '../EnsemblePrompt'
import type { ChatRecord, EnsembleConfig } from '../store/types'
import { isBackgroundParticipant } from './EnsembleFanoutPolicy'

export const PROPOSED_PLAN_BLOCK = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i
const PROPOSED_PLAN_BLOCK_GLOBAL = /<proposed_plan>[\s\S]*?<\/proposed_plan>/gi

export function deriveProposedPlanTitle(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    const text = (heading ? heading[1] : line.replace(/^[-*+]\s+/, '')).trim()
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text
  }
  return 'Proposed plan'
}

export function parseExplicitProposedPlan(text: string): { title: string; body: string } | null {
  const match = text.match(PROPOSED_PLAN_BLOCK)
  if (!match) return null
  const body = match[1].trim()
  if (!body) return null
  return { title: deriveProposedPlanTitle(body), body }
}

export function stripExplicitProposedPlanBlock(text: string): string {
  if (!PROPOSED_PLAN_BLOCK.test(text)) return text
  return text.replace(PROPOSED_PLAN_BLOCK_GLOBAL, '').trim()
}

export function cleanParticipantId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveEnsembleProposedPlanOwnerId(
  config: EnsembleConfig,
  roundId: string
): string | null {
  const orderedParticipants = getOrderedEnsembleParticipants(config).filter(
    (participant) => !isBackgroundParticipant(participant)
  )
  const bossmanId = cleanParticipantId(config.bossmanParticipantId)
  if (bossmanId && orderedParticipants.some((participant) => participant.id === bossmanId)) {
    return bossmanId
  }

  const activeRoundParticipants =
    config.activeRound?.roundId === roundId ? config.activeRound.participants : []
  const activeFallback = [...activeRoundParticipants].sort((a, b) => a.order - b.order).at(-1)
  return (
    cleanParticipantId(activeFallback?.participantId) ||
    cleanParticipantId(orderedParticipants.at(-1)?.id)
  )
}

export function shouldStampEnsembleProposedPlan(
  chat: ChatRecord,
  roundId: string,
  participantId: string
): boolean {
  if (chat.workflowMode !== 'plan' || !chat.ensemble) return false
  return (
    cleanParticipantId(participantId) === resolveEnsembleProposedPlanOwnerId(chat.ensemble, roundId)
  )
}
