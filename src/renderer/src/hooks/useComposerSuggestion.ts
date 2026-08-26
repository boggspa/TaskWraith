import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveComposerSuggestionCandidates,
  type ComposerSuggestion,
  type ComposerSuggestionLane,
  type ComposerSuggestionModel
} from '../lib/composerSuggestion'
import type { ComposerContinuationCheckpoint } from '../lib/composerContinuationCheckpoint'
import { buildComposerContinuationProposalRequest } from '../lib/composerContinuationProposal'
import { recordComposerSuggestionEvent } from '../lib/composerSuggestionLog'
import {
  personalizeComposerSuggestionText,
  readComposerSuggestionPersonalization,
  recordComposerSuggestionFeedback,
  recordComposerSuggestionSentPrompt,
  selectPersonalizedComposerSuggestion,
  type ComposerSuggestionPersonalizationProfile,
  type ComposerSuggestionSelectionSource
} from '../lib/composerSuggestionPersonalization'
import type {
  ContinuationProposalRequest,
  ContinuationProposalSnapshot
} from '../../../main/store/types'

/**
 * Owns the lifecycle of the composer's ghost prefill: which suggestion
 * is live, whether the user has waved it away, and the acceptance log
 * entries that let the trigger table be judged later.
 *
 * The single invariant worth stating loudly: **an unaccepted suggestion
 * never becomes draft text.** `ghostText` is painted by the overlay and
 * exists nowhere else — it is not fed through the textarea's `onChange`,
 * so it never reaches `setChatPromptDraft` and never lands in draft
 * persistence. Only `accept()` returns a string, and only the caller's
 * explicit Tab handler calls it. Without that separation a suggestion
 * the user ignored would be sitting there the next time they opened the
 * chat, indistinguishable from something they typed themselves.
 */

export interface UseComposerSuggestionArgs {
  /** Scopes dismissals, so waving one away in chat A doesn't mute chat B. */
  chatId: string | null | undefined
  draft: string
  busy: boolean
  hasPriorTurn: boolean
  consideredModel: ComposerSuggestionModel | null
  selectedModelKey: string | null
  failedLanes?: readonly ComposerSuggestionLane[]
  continuationCheckpoint?: ComposerContinuationCheckpoint | null
  /** Optional local-only ranker. It receives no prompt, telemetry, or display text. */
  requestContinuationProposal?: (
    request: ContinuationProposalRequest
  ) => Promise<ContinuationProposalSnapshot>
  uncommittedFileCount: number
  branch: string | null
  /** Escape hatch for users who don't want prefills at all. */
  enabled?: boolean
}

export interface ComposerSuggestionController {
  /** Text for the overlay to paint, or null when there's nothing to offer. */
  ghostText: string | null
  /** Why the live suggestion is safe and relevant; suitable for a tooltip. */
  explanation: string | null
  /** How the candidate was selected, without exposing prompt or telemetry data. */
  selectionSource: ComposerSuggestionSelectionSource | null
  /**
   * Commit the live suggestion. Returns the string the caller should
   * write into the draft, or null when nothing is live — so a stray Tab
   * can never blank or corrupt the composer.
   */
  accept: () => string | null
  /** Wave the live suggestion away; it won't be re-offered in this chat. */
  dismiss: () => void
  /** Learn aggregate style/edit signals when the user actually sends a prompt. */
  observeSentDraft: (draft: string) => void
}

const NO_LANES: readonly ComposerSuggestionLane[] = []
const NO_DISMISSALS: readonly string[] = []

export function useComposerSuggestion(
  args: UseComposerSuggestionArgs
): ComposerSuggestionController {
  const {
    chatId,
    draft,
    busy,
    hasPriorTurn,
    consideredModel,
    selectedModelKey,
    failedLanes = NO_LANES,
    continuationCheckpoint = null,
    requestContinuationProposal,
    uncommittedFileCount,
    branch,
    enabled = true
  } = args

  const scope = chatId || '__unscoped__'

  const [personalizationByScope, setPersonalizationByScope] = useState<
    Record<string, ComposerSuggestionPersonalizationProfile>
  >({})
  const persistedPersonalization = useMemo(
    () => readComposerSuggestionPersonalization(chatId),
    [chatId]
  )
  const personalization = personalizationByScope[scope] ?? persistedPersonalization
  const setPersonalization = useCallback(
    (profile: ComposerSuggestionPersonalizationProfile) => {
      setPersonalizationByScope((previous) => ({ ...previous, [scope]: profile }))
    },
    [scope]
  )

  // Profiles are deliberately per-thread. On a chat switch, the render reads
  // only that chat's aggregate localStorage record; no transcript content is
  // ever loaded into this hook.

  /**
   * Dismissals are keyed by chat so waving one away in one conversation
   * doesn't mute another, and held in state rather than a ref so the
   * derive below re-runs when one lands. Deliberately not persisted: a
   * dismissal is a "not now", not a preference, and should not outlive
   * the session.
   */
  const [dismissedByChat, setDismissedByChat] = useState<Record<string, readonly string[]>>({})

  const dismissedForScope = useMemo(
    () => new Set(dismissedByChat[scope] ?? NO_DISMISSALS),
    [dismissedByChat, scope]
  )

  const candidates = useMemo(() => {
    if (!enabled) return []
    return deriveComposerSuggestionCandidates({
      draft,
      busy,
      hasPriorTurn,
      consideredModel,
      selectedModelKey,
      failedLanes,
      continuationCheckpoint,
      uncommittedFileCount,
      branch,
      dismissedIds: dismissedForScope
    })
  }, [
    enabled,
    draft,
    busy,
    hasPriorTurn,
    consideredModel,
    selectedModelKey,
    failedLanes,
    continuationCheckpoint,
    uncommittedFileCount,
    branch,
    dismissedForScope
  ])

  const continuationProposalRequest = useMemo(
    () => buildComposerContinuationProposalRequest(chatId, continuationCheckpoint, candidates),
    [chatId, continuationCheckpoint, candidates]
  )
  const proposalKey = useMemo(
    () =>
      continuationProposalRequest
        ? JSON.stringify({
            chatId: continuationProposalRequest.chatId,
            checkpointId: continuationProposalRequest.checkpointId,
            phase: continuationProposalRequest.phase,
            roundState: continuationProposalRequest.roundState,
            candidates: continuationProposalRequest.candidates
          })
        : null,
    [continuationProposalRequest]
  )
  const [proposal, setProposal] = useState<{ requestKey: string; candidateId: string } | null>(null)
  const lastProposalRequestKeyRef = useRef<string | null>(null)

  // Foundation Models is an untrusted, bounded ranker. The request adapter
  // contains only host-generated enum state and opaque ids, and this effect
  // accepts a response only when it selects a candidate that still exists.
  useEffect(() => {
    if (!requestContinuationProposal || !continuationProposalRequest || !proposalKey) {
      lastProposalRequestKeyRef.current = null
      return
    }

    // Chat records can be rehydrated without their checkpoint changing. Do not
    // spend another local-model turn just because an equivalent object arrived.
    if (lastProposalRequestKeyRef.current === proposalKey) return
    lastProposalRequestKeyRef.current = proposalKey

    let cancelled = false

    void requestContinuationProposal(continuationProposalRequest)
      .then((snapshot) => {
        if (cancelled || snapshot.status !== 'ready' || !snapshot.candidateId) return
        if (snapshot.checkpointId !== continuationProposalRequest.checkpointId) return
        if (
          !continuationProposalRequest.candidates.some(
            (candidate) => candidate.id === snapshot.candidateId
          )
        ) {
          return
        }
        setProposal({ requestKey: proposalKey, candidateId: snapshot.candidateId })
      })
      .catch(() => {
        // The deterministic candidate ordering is the normal fallback.
      })

    return () => {
      cancelled = true
    }
  }, [continuationProposalRequest, proposalKey, requestContinuationProposal])

  // A response is usable only for the exact current request. This lets a new
  // checkpoint fall back immediately while an older model response is ignored.
  const proposedCandidateId = proposal?.requestKey === proposalKey ? proposal.candidateId : null

  const selection = useMemo(
    () => selectPersonalizedComposerSuggestion(candidates, personalization, proposedCandidateId),
    [candidates, personalization, proposedCandidateId]
  )
  const suggestion: ComposerSuggestion | null = selection?.candidate.suggestion ?? null
  const suggestionText = selection
    ? personalizeComposerSuggestionText(selection.candidate, personalization)
    : null

  /**
   * Log `shown` once per suggestion identity, not once per render. The
   * composer re-renders constantly; a shown-count inflated by render
   * churn would make every accept rate look like noise and defeat the
   * point of keeping the log at all.
   */
  const lastShownIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!suggestion) {
      lastShownIdRef.current = null
      return
    }
    if (lastShownIdRef.current === suggestion.id) return
    lastShownIdRef.current = suggestion.id
    recordComposerSuggestionEvent(suggestion.trigger, 'shown')
    recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'shown')
  }, [chatId, suggestion])

  const acceptedSuggestionRef = useRef<{ chatId: string | null | undefined; text: string } | null>(
    null
  )

  const retire = useCallback(
    (id: string) => {
      setDismissedByChat((prev) => {
        const existing = prev[scope] ?? NO_DISMISSALS
        if (existing.includes(id)) return prev
        return { ...prev, [scope]: [...existing, id] }
      })
    },
    [scope]
  )

  const accept = useCallback((): string | null => {
    if (!suggestion || !suggestionText) return null
    recordComposerSuggestionEvent(suggestion.trigger, 'accepted')
    setPersonalization(recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'accepted'))
    // Retire it as well as logging: once accepted it must not re-offer
    // itself the moment the user clears the composer to start over.
    retire(suggestion.id)
    acceptedSuggestionRef.current = { chatId, text: suggestionText }
    return suggestionText
  }, [chatId, retire, setPersonalization, suggestion, suggestionText])

  const dismiss = useCallback((): void => {
    if (!suggestion) return
    recordComposerSuggestionEvent(suggestion.trigger, 'dismissed')
    setPersonalization(recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'dismissed'))
    retire(suggestion.id)
  }, [chatId, retire, setPersonalization, suggestion])

  const observeSentDraft = useCallback(
    (sentDraft: string): void => {
      const acceptedSuggestion = acceptedSuggestionRef.current
      setPersonalization(
        recordComposerSuggestionSentPrompt(
          chatId,
          sentDraft,
          acceptedSuggestion && acceptedSuggestion.chatId === chatId
            ? acceptedSuggestion.text
            : null
        )
      )
      acceptedSuggestionRef.current = null
    },
    [chatId, setPersonalization]
  )

  const explanation = suggestion
    ? selection?.source === 'local-preference'
      ? `${suggestion.explanation || 'Based on current TaskWraith state.'} Locally ranked from your accept and dismiss feedback in this thread.`
      : selection?.source === 'foundation-model-proposal'
        ? `${suggestion.explanation || 'Based on current TaskWraith state.'} Apple Foundation Models on this Mac ranked only host-approved choices.`
        : suggestion.explanation || null
    : null

  return {
    ghostText: suggestionText,
    explanation,
    selectionSource: selection?.source ?? null,
    accept,
    dismiss,
    observeSentDraft
  }
}
