import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'
import { withExplicitEnsembleDmTarget } from './runPromptDmScope'

export function lastRetryableEnsembleUserPrompt(messages: ChatMessage[] | undefined): string {
  const lastUserMessage = [...(messages || [])]
    .reverse()
    .find((message) => message.role === 'user' && message.metadata?.kind !== 'channelInbound')
  return lastUserMessage?.content?.trim() || ''
}

/**
 * What the participant Retry chip should dispatch.
 *
 * Retrying one failed seat is "give this seat a lane now", not "start again".
 * So a live round is JOINED: the prompt is steered, and MAIN's
 * `launchUserFanoutForAbsorbedSteer` reads the structured mention and opens an
 * additive User Fan-Out lane for that seat. The round keeps its own shape and
 * the current speaker is never interrupted to make room.
 *
 * The steer deliberately carries NO `dmTargetParticipantId` and no
 * `fanoutPolicy`. Both are absorbed onto the LIVE round — the target narrows
 * every remaining serial turn to that seat, and the policy re-clamps fan-out
 * for the whole round. Retrying one seat asks for neither. The structured
 * `ensemble-dm://` mention in the prompt is what names the seat, and MAIN
 * validates it independently of any advisory id the renderer sends.
 *
 * Only an idle chat gets a fresh round, where a DM scope is the whole point:
 * there is no round to join, so the retry owns one limited to the failed seat.
 */
export type EnsembleParticipantRetryDispatch =
  | { kind: 'none'; reason: string }
  | { kind: 'steer'; prompt: string }
  | { kind: 'freshRound'; prompt: string; dmTargetParticipantId: string }

export function resolveEnsembleParticipantRetryDispatch(input: {
  chat: ChatRecord | null | undefined
  participantId: string
}): EnsembleParticipantRetryDispatch {
  const chat = input.chat
  if (!chat) return { kind: 'none', reason: 'Retry: no chat is selected.' }
  const retryPrompt = lastRetryableEnsembleUserPrompt(chat.messages)
  if (!retryPrompt) {
    return {
      kind: 'none',
      reason: 'Retry: no prior user prompt on this chat to re-dispatch with.'
    }
  }
  const prompt = withExplicitEnsembleDmTarget({
    prompt: retryPrompt,
    participantId: input.participantId,
    participants: chat.ensemble?.participants
  })
  if (isEnsembleActiveRoundDispatchLive(chat.ensemble?.activeRound)) {
    return { kind: 'steer', prompt }
  }
  return { kind: 'freshRound', prompt, dmTargetParticipantId: input.participantId }
}
