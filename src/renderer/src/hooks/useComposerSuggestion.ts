import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContinuationProposalRequest,
  ContinuationProposalSnapshot
} from '../../../main/store/types'
import {
  deriveComposerSuggestionCandidates,
  type ComposerSuggestion
} from '../lib/composerSuggestion'
import type { ComposerContinuationCheckpoint } from '../lib/composerContinuationCheckpoint'
import { recordComposerSuggestionEvent } from '../lib/composerSuggestionLog'
import {
  recordComposerSuggestionFeedback,
  recordComposerSuggestionSentPrompt,
  type ComposerSuggestionSelectionSource
} from '../lib/composerSuggestionPersonalization'

export interface UseComposerSuggestionArgs {
  chatId: string | null | undefined
  draft: string
  busy: boolean
  hasNonTextPromptContent?: boolean
  checkpoint?: ComposerContinuationCheckpoint | null
  requestContinuationProposal?: (
    request: ContinuationProposalRequest
  ) => Promise<ContinuationProposalSnapshot>
  onTitleProposal?: (snapshot: ContinuationProposalSnapshot) => void
  enabled?: boolean
  displayDeadlineMs?: number
}

export interface ComposerSuggestionAcceptance {
  text: string
  targetParticipantId?: string
  targetMentionText?: string
}

export interface ComposerSuggestionController {
  ghostText: string | null
  explanation: string | null
  selectionSource: ComposerSuggestionSelectionSource | null
  accept: () => ComposerSuggestionAcceptance | null
  dismiss: () => void
  observeSentDraft: (draft: string) => void
}

const NO_DISMISSALS: readonly string[] = []

export function useComposerSuggestion(
  args: UseComposerSuggestionArgs
): ComposerSuggestionController {
  const {
    chatId,
    draft,
    busy,
    hasNonTextPromptContent = false,
    checkpoint = null,
    requestContinuationProposal,
    onTitleProposal,
    enabled = true,
    displayDeadlineMs = 3_500
  } = args
  const scope = chatId || '__unscoped__'
  const [dismissedByChat, setDismissedByChat] = useState<Record<string, readonly string[]>>({})
  const dismissedForScope = useMemo(
    () => new Set(dismissedByChat[scope] ?? NO_DISMISSALS),
    [dismissedByChat, scope]
  )

  const retire = useCallback(
    (id: string) => {
      setDismissedByChat((previous) => {
        const existing = previous[scope] ?? NO_DISMISSALS
        if (existing.includes(id)) return previous
        return { ...previous, [scope]: [...existing, id] }
      })
    },
    [scope]
  )

  const scopedChatId = chatId?.trim().slice(0, 180) || ''
  const titleContextVersion =
    enabled && checkpoint?.titleNeedsProposal ? `${checkpoint.titleId}:title` : null
  const titleRequest = useMemo<ContinuationProposalRequest | null>(
    () =>
      scopedChatId && titleContextVersion
        ? {
            schemaVersion: 2,
            chatId: scopedChatId,
            contextVersion: titleContextVersion,
            purpose: 'title'
          }
        : null,
    [scopedChatId, titleContextVersion]
  )
  useEffect(() => {
    if (!requestContinuationProposal || !titleRequest || !onTitleProposal) return
    let cancelled = false
    void requestContinuationProposal(titleRequest)
      .then((snapshot) => {
        if (cancelled || snapshot.contextVersion !== titleRequest.contextVersion) return
        if (snapshot.status === 'ready' && snapshot.title) onTitleProposal(snapshot)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [onTitleProposal, requestContinuationProposal, titleRequest])

  const draftContextVersion =
    enabled &&
    !busy &&
    draft.length === 0 &&
    !hasNonTextPromptContent &&
    checkpoint?.hasUserRequest &&
    checkpoint.hasSettledAssistant &&
    checkpoint.phase !== 'complete'
      ? `${checkpoint.id}:draft`
      : null
  const draftRequest = useMemo<ContinuationProposalRequest | null>(
    () =>
      scopedChatId && draftContextVersion
        ? {
            schemaVersion: 2,
            chatId: scopedChatId,
            contextVersion: draftContextVersion,
            purpose: 'draft'
          }
        : null,
    [draftContextVersion, scopedChatId]
  )
  const draftRequestKey = draftRequest ? JSON.stringify(draftRequest) : null
  const [proposalState, setProposalState] = useState<{
    requestKey: string
    snapshot: ContinuationProposalSnapshot
  } | null>(null)

  useEffect(() => {
    if (!requestContinuationProposal || !draftRequest || !draftRequestKey) {
      setProposalState(null)
      return
    }
    setProposalState(null)
    let cancelled = false
    const startedAt = Date.now()
    void requestContinuationProposal(draftRequest)
      .then((snapshot) => {
        if (cancelled || Date.now() - startedAt > displayDeadlineMs) return
        if (snapshot.contextVersion !== draftRequest.contextVersion) return
        if (snapshot.status !== 'ready') return
        if (snapshot.title) onTitleProposal?.(snapshot)
        if (snapshot.proposals.length === 0) return
        setProposalState({ requestKey: draftRequestKey, snapshot })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    displayDeadlineMs,
    draftRequest,
    draftRequestKey,
    onTitleProposal,
    requestContinuationProposal
  ])

  const liveSnapshot = proposalState?.requestKey === draftRequestKey ? proposalState.snapshot : null
  const candidates = useMemo(
    () =>
      deriveComposerSuggestionCandidates({
        draft,
        busy,
        proposals: liveSnapshot?.proposals || [],
        dismissedIds: dismissedForScope
      }),
    [busy, dismissedForScope, draft, liveSnapshot]
  )
  const suggestion: ComposerSuggestion | null = candidates[0]?.suggestion ?? null

  const lastShownIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!suggestion) return
    if (lastShownIdRef.current === suggestion.id) return
    lastShownIdRef.current = suggestion.id
    recordComposerSuggestionEvent(suggestion.trigger, 'shown')
    recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'shown')
  }, [chatId, suggestion])

  const lastVisibleSuggestionRef = useRef<{
    chatId: string | null | undefined
    suggestion: ComposerSuggestion
  } | null>(null)
  useEffect(() => {
    if (suggestion) lastVisibleSuggestionRef.current = { chatId, suggestion }
  }, [chatId, suggestion])
  useEffect(() => {
    if (suggestion || draft.trim()) return
    lastVisibleSuggestionRef.current = null
  }, [chatId, draft, suggestion])
  useEffect(() => {
    const previous = lastVisibleSuggestionRef.current
    if (!draft.trim() || !previous) return
    if (previous.chatId !== chatId) {
      lastVisibleSuggestionRef.current = null
      return
    }
    recordComposerSuggestionEvent(previous.suggestion.trigger, 'dismissed')
    recordComposerSuggestionFeedback(chatId, previous.suggestion.trigger, 'dismissed')
    retire(previous.suggestion.id)
    lastVisibleSuggestionRef.current = null
  }, [chatId, draft, retire])

  const acceptedSuggestionRef = useRef<{
    chatId: string | null | undefined
    text: string
    seenInDraft: boolean
  } | null>(null)

  useEffect(() => {
    const accepted = acceptedSuggestionRef.current
    if (!accepted) return
    if (accepted.chatId !== chatId) {
      acceptedSuggestionRef.current = null
      return
    }
    if (draft === accepted.text) {
      accepted.seenInDraft = true
    } else if (accepted.seenInDraft && !draft.trim()) {
      acceptedSuggestionRef.current = null
    }
  }, [chatId, draft])

  const accept = useCallback((): ComposerSuggestionAcceptance | null => {
    if (!suggestion) return null
    recordComposerSuggestionEvent(suggestion.trigger, 'accepted')
    recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'accepted')
    retire(suggestion.id)
    lastVisibleSuggestionRef.current = null
    acceptedSuggestionRef.current = { chatId, text: suggestion.text, seenInDraft: false }
    return {
      text: suggestion.text,
      ...(suggestion.targetParticipantId
        ? {
            targetParticipantId: suggestion.targetParticipantId,
            targetMentionText: suggestion.targetMentionText
          }
        : {})
    }
  }, [chatId, retire, suggestion])

  const dismiss = useCallback((): void => {
    if (!suggestion) return
    recordComposerSuggestionEvent(suggestion.trigger, 'dismissed')
    recordComposerSuggestionFeedback(chatId, suggestion.trigger, 'dismissed')
    retire(suggestion.id)
    lastVisibleSuggestionRef.current = null
  }, [chatId, retire, suggestion])

  const observeSentDraft = useCallback(
    (sentDraft: string): void => {
      const accepted = acceptedSuggestionRef.current
      recordComposerSuggestionSentPrompt(
        chatId,
        sentDraft,
        accepted && accepted.chatId === chatId ? accepted.text : null
      )
      acceptedSuggestionRef.current = null
    },
    [chatId]
  )

  return {
    ghostText: suggestion?.text || null,
    explanation: suggestion?.explanation || null,
    selectionSource: suggestion ? 'foundation-model-proposal' : null,
    accept,
    dismiss,
    observeSentDraft
  }
}
