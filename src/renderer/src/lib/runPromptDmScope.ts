import type { EnsembleParticipant } from '../../../main/store/types'
import {
  extractFirstEnsembleDmTarget,
  formatEnsembleDmMention
} from './ComposerMentionTrigger'

/**
 * Stamp an exact UI gesture (participant-chip DM or Retry) into the prompt so
 * MAIN can validate participant identity independently of the renderer's
 * advisory id. Structured identity wins over aliases already present in an old
 * retry prompt and renders as a participant chip in the transcript.
 */
export function withExplicitEnsembleDmTarget(input: {
  prompt: string
  participantId: string
  participants?: EnsembleParticipant[]
}): string {
  const participant = input.participants?.find(
    (candidate) => candidate.id === input.participantId
  )
  const label = participant?.role?.trim() || participant?.provider || input.participantId
  // A Retry can reuse an old user prompt that already contains a structured
  // target. Preserve its visible @label as ordinary text, but remove the stale
  // identity marker before prepending the user's new explicit target; leaving
  // both links would correctly look multi-target to MAIN and reject the retry.
  const promptWithoutStaleTargets = input.prompt.replace(
    /\[(@(?:\\.|[^\]])+)\]\(ensemble-dm:\/\/[^)\s]+\)/g,
    (_match, visibleLabel: string) => visibleLabel.replace(/\\([\\\]])/g, '$1')
  )
  return `${formatEnsembleDmMention(label, input.participantId)}${promptWithoutStaleTargets}`
}

export function resolveComposerRunDmTarget(input: {
  explicitParticipantId?: string
  prompt: string
  participants?: EnsembleParticipant[]
  inferFromPrompt: boolean
}): string | undefined {
  if (input.explicitParticipantId) return input.explicitParticipantId
  if (!input.inferFromPrompt) return undefined
  return extractFirstEnsembleDmTarget(input.prompt, input.participants) || undefined
}
