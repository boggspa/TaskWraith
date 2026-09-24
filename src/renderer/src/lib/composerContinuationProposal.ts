import type {
  ChatRecord,
  ContinuationProposalPurpose,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  ContinuationTitleApplyRequest
} from '../../../main/store/types'
import { threadTitleSourceFingerprint } from '../../../shared/threadTitles'
import type { ComposerContinuationCheckpoint } from './composerContinuationCheckpoint'

export function buildComposerContinuationProposalRequest(
  chatId: string | null | undefined,
  checkpoint: ComposerContinuationCheckpoint | null | undefined,
  purpose: ContinuationProposalPurpose
): ContinuationProposalRequest | null {
  const scopedChatId = chatId?.trim().slice(0, 180) || ''
  if (!scopedChatId || !checkpoint) return null
  if (purpose === 'draft') {
    if (!checkpoint.hasUserRequest || !checkpoint.hasSettledAssistant) return null
    if (checkpoint.phase === 'complete') return null
  } else if (!checkpoint.titleNeedsProposal) {
    return null
  }
  return {
    schemaVersion: 2,
    chatId: scopedChatId,
    contextVersion: `${purpose === 'title' ? checkpoint.titleId : checkpoint.id}:${purpose}`,
    purpose
  }
}

/** Optimistic renderer CAS; main revalidates provenance in AppStore.saveChat. */
export function applyLocalAiTitleProposal(
  chat: ChatRecord,
  snapshot: ContinuationProposalSnapshot
): ChatRecord | null {
  if (
    snapshot.status !== 'ready' ||
    !snapshot.title ||
    !snapshot.titleSourceMessageId ||
    !snapshot.titleSourceFingerprint ||
    !snapshot.titleExpectedCurrent ||
    !snapshot.fingerprint ||
    chat.title !== snapshot.titleExpectedCurrent
  ) {
    return null
  }
  if (chat.threadTitle?.source === 'user' || chat.threadTitle?.source === 'local-ai') return null
  const source = (chat.messages || []).find(
    (message) => message.id === snapshot.titleSourceMessageId && message.role === 'user'
  )
  if (!source) return null
  if (threadTitleSourceFingerprint(source.id, source.content) !== snapshot.titleSourceFingerprint) {
    return null
  }
  if (
    chat.threadTitle?.sourceMessageId &&
    chat.threadTitle.sourceMessageId !== snapshot.titleSourceMessageId
  ) {
    return null
  }
  return {
    ...chat,
    title: snapshot.title,
    threadTitle: {
      source: 'local-ai',
      sourceMessageId: snapshot.titleSourceMessageId,
      sourceFingerprint: snapshot.titleSourceFingerprint,
      evidenceFingerprint: snapshot.fingerprint
    }
  }
}

export function buildContinuationTitleApplyRequest(
  chatId: string,
  snapshot: ContinuationProposalSnapshot
): ContinuationTitleApplyRequest | null {
  if (
    snapshot.status !== 'ready' ||
    !snapshot.title ||
    !snapshot.titleSourceMessageId ||
    !snapshot.titleSourceFingerprint ||
    !snapshot.titleExpectedCurrent ||
    !snapshot.fingerprint
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    chatId,
    title: snapshot.title,
    sourceMessageId: snapshot.titleSourceMessageId,
    sourceFingerprint: snapshot.titleSourceFingerprint,
    evidenceFingerprint: snapshot.fingerprint,
    expectedTitle: snapshot.titleExpectedCurrent
  }
}
