import type { EnsembleParticipant } from '../../../main/store/types'
import { extractFirstEnsembleDmTarget } from './ComposerMentionTrigger'

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
