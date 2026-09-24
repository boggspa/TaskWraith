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

import {
  ensembleRoundDispatchRefusal,
  type EnsembleRoundDispatchReceipt,
  type EnsembleRoundDispatchRefusal
} from './ensembleRoundDispatchReceipt'

export interface EnsembleParticipantRetryOptions {
  /**
   * Called when the retry could not be landed on ANY lane. Optional so the
   * existing call sites are unchanged, but a caller that omits it is choosing
   * not to tell the user -- prefer passing it.
   */
  onRefused?: (refusal: EnsembleRoundDispatchRefusal) => void
}

export type EnsembleParticipantRetryResult =
  | { ok: true; lane: 'steer' | 'freshRound' }
  | { ok: false; reason: string }

/**
 * Execute a one-seat retry. This is THE retry path — the roster chip's Retry
 * button and the SeatFailureCard's Retry action both call here, so the two
 * surfaces can never disagree about what "retry" does: a live round is
 * joined as an additive User Fan-Out lane for the seat (steer), an idle chat
 * gets a fresh DM round scoped to the seat. Returns the failure reason
 * instead of throwing so each call site can surface it in its own voice.
 */
export function retryEnsembleParticipant(
  chat: ChatRecord | null | undefined,
  participantId: string,
  options?: EnsembleParticipantRetryOptions
): EnsembleParticipantRetryResult {
  const dispatch = resolveEnsembleParticipantRetryDispatch({ chat, participantId })
  if (dispatch.kind === 'none') return { ok: false, reason: dispatch.reason }
  if (typeof window === 'undefined' || typeof window.api?.runEnsembleRound !== 'function') {
    return { ok: false, reason: 'Retry: the run bridge is unavailable.' }
  }
  if (!chat) return { ok: false, reason: 'Retry: no chat is selected.' }
  const runEnsembleRound = window.api.runEnsembleRound
  const classify = (receipt: unknown): EnsembleRoundDispatchRefusal | null =>
    ensembleRoundDispatchRefusal(receipt as EnsembleRoundDispatchReceipt | null | undefined)
  // A dispatch that threw proves NOTHING about delivery -- the steer may
  // already have been accepted -- so it is surfaced and never retried. That is
  // the same rule RunRecovery applies to an ambiguous steer.
  const surfaceThrow = (): void =>
    options?.onRefused?.({
      reason: 'threw',
      message: 'Retry: the dispatch failed before the round could answer.'
    })
  const freshRound = (): Promise<unknown> =>
    Promise.resolve(
      runEnsembleRound({
        chatId: chat.appChatId,
        prompt: dispatch.prompt,
        mode: 'normal',
        concurrentMode: false,
        fanoutPolicy: 'off',
        dmTargetParticipantId: participantId
      })
    )

  if (dispatch.kind === 'steer') {
    // The lane above is chosen with `isEnsembleActiveRoundDispatchLive`, which
    // chatBusyState re-exports from `isEnsembleRoundPresentationLive` -- the
    // PRESENTATION predicate under a "dispatch" name. It reports live during a
    // turnTransition handoff, where main's absorb gate uses the weaker dispatch
    // predicate and refuses. Voiding the promise made that refusal invisible
    // and the retry evaporated, so the receipt is now observed and a refused
    // steer is landed on the other lane instead.
    //
    // Safe from double delivery: `ensembleRoundDispatchRefusal` returns non-null
    // only for statuses `isAcceptedEnsembleSteerResult` rejects, so a refusal is
    // main stating it did not retain the prompt.
    void Promise.resolve(
      runEnsembleRound({ chatId: chat.appChatId, prompt: dispatch.prompt, mode: 'steer' })
    )
      .then((receipt) => {
        if (!classify(receipt)) return undefined
        return freshRound().then((fallback) => {
          const refusal = classify(fallback)
          if (refusal) options?.onRefused?.(refusal)
        })
      })
      .catch(surfaceThrow)
    return { ok: true, lane: 'steer' }
  }

  void freshRound()
    .then((receipt) => {
      const refusal = classify(receipt)
      if (refusal) options?.onRefused?.(refusal)
    })
    .catch(surfaceThrow)
  return { ok: true, lane: 'freshRound' }
}
