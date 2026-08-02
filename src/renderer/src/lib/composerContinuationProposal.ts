/**
 * Converts already-approved composer candidates into the text-free protocol
 * used by the optional local Foundation Models ranker.
 *
 * Keep this separate from checkpoint construction: the checkpoint decides
 * which task facts are authoritative; this adapter merely exposes opaque ids
 * for ranking. It must never forward a candidate's display text.
 */

import type { ContinuationProposalRequest } from '../../../main/store/types'
import type { ComposerSuggestionCandidate } from './composerSuggestion'
import type { ComposerContinuationCheckpoint } from './composerContinuationCheckpoint'

const SAFE_IDENTIFIER = /^[A-Za-z0-9._,:-]{1,180}$/

export function buildComposerContinuationProposalRequest(
  chatId: string | null | undefined,
  checkpoint: ComposerContinuationCheckpoint | null | undefined,
  candidates: readonly ComposerSuggestionCandidate[]
): ContinuationProposalRequest | null {
  const scopedChatId = chatId?.trim().slice(0, 180) || ''
  if (!scopedChatId || !checkpoint || !SAFE_IDENTIFIER.test(checkpoint.id)) return null

  const seen = new Set<string>()
  const proposalCandidates = candidates.flatMap((candidate) => {
    const id = candidate.suggestion.id
    if (!SAFE_IDENTIFIER.test(id) || seen.has(id)) return []
    seen.add(id)
    return [{ id, kind: candidate.suggestion.trigger }]
  })

  // A local model adds no information when there is only one valid choice.
  if (proposalCandidates.length < 2) return null

  return {
    chatId: scopedChatId,
    checkpointId: checkpoint.id,
    phase: checkpoint.phase,
    roundState: checkpoint.roundState,
    candidates: proposalCandidates
  }
}
