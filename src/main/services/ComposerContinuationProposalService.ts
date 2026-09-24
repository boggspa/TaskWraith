import {
  buildContinuationAbstainedSnapshot,
  buildContinuationEvidenceSnapshot,
  buildContinuationProposalUnavailableSnapshot,
  buildContinuationStaleSnapshot,
  continuationEvidenceCanDraft,
  normalizeContinuationProposalResult
} from '../ContinuationProposal'
import type { ContinuationEvidenceSnapshot } from '../ContinuationProposal'
import type {
  ChatRecord,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  ContinuationTitleApplyRequest,
  ContinuationTitleApplyResult
} from '../store/types'

export interface ContinuationBridgeDaemon {
  status: () => { running: boolean }
  request: (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>
}

export interface ComposerContinuationProposalService {
  propose: (request: ContinuationProposalRequest) => Promise<ContinuationProposalSnapshot>
  applyTitle: (request: ContinuationTitleApplyRequest) => Promise<ContinuationTitleApplyResult>
}

export interface ComposerContinuationProposalServiceDeps {
  getChat: (chatId: string) => ChatRecord | null | Promise<ChatRecord | null>
  applyTitle: (
    request: ContinuationTitleApplyRequest
  ) => ChatRecord | null | Promise<ChatRecord | null>
  getBridgeDaemon: () => ContinuationBridgeDaemon | null
  nowIso?: () => string
  timeoutMs?: number
  maxCacheEntries?: number
}

function forRequest(
  snapshot: ContinuationProposalSnapshot,
  request: ContinuationProposalRequest
): ContinuationProposalSnapshot {
  return {
    ...snapshot,
    chatId: request.chatId,
    contextVersion: request.contextVersion
  }
}

export function createComposerContinuationProposalService(
  deps: ComposerContinuationProposalServiceDeps
): ComposerContinuationProposalService {
  const nowIso = deps.nowIso || (() => new Date().toISOString())
  const timeoutMs = deps.timeoutMs ?? 2_500
  const maxCacheEntries = Math.max(1, deps.maxCacheEntries ?? 64)
  const cache = new Map<string, ContinuationProposalSnapshot>()
  const inFlight = new Map<string, Promise<ContinuationProposalSnapshot>>()

  const remember = (key: string, snapshot: ContinuationProposalSnapshot): void => {
    if (snapshot.status !== 'ready' && snapshot.status !== 'abstained') return
    cache.delete(key)
    cache.set(key, snapshot)
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value
      if (typeof oldest !== 'string') break
      cache.delete(oldest)
    }
  }

  const generate = async (
    request: ContinuationProposalRequest,
    key: string,
    evidenceBefore: ContinuationEvidenceSnapshot
  ): Promise<ContinuationProposalSnapshot> => {
    const generatedAt = nowIso()
    if (request.purpose === 'draft' && !continuationEvidenceCanDraft(evidenceBefore)) {
      return buildContinuationAbstainedSnapshot(request, generatedAt, 'no-actionable-evidence', {
        fingerprint: evidenceBefore.fingerprint
      })
    }
    if (request.purpose === 'title' && !evidenceBefore.title.eligible) {
      return buildContinuationAbstainedSnapshot(request, generatedAt, 'title-not-eligible', {
        fingerprint: evidenceBefore.fingerprint
      })
    }

    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return buildContinuationProposalUnavailableSnapshot(
        request,
        'TaskWraith bridge daemon is not running.',
        generatedAt
      )
    }

    try {
      const raw = await daemon.request('continuation.propose', evidenceBefore, { timeoutMs })
      const chatAfter = await deps.getChat(request.chatId)
      const evidenceAfter = chatAfter
        ? buildContinuationEvidenceSnapshot(chatAfter, request.purpose)
        : null
      if (!evidenceAfter || evidenceAfter.fingerprint !== evidenceBefore.fingerprint) {
        return buildContinuationStaleSnapshot(request, nowIso(), 'evidence-changed')
      }
      const result = normalizeContinuationProposalResult(request, evidenceBefore, raw, nowIso())
      remember(key, result)
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return buildContinuationProposalUnavailableSnapshot(request, reason, nowIso())
    }
  }

  return {
    propose: async (request) => {
      const chat = await deps.getChat(request.chatId)
      const evidence = chat ? buildContinuationEvidenceSnapshot(chat, request.purpose) : null
      if (!evidence) {
        return buildContinuationAbstainedSnapshot(request, nowIso(), 'no-user-intent')
      }
      const key = `${request.purpose}:${evidence.fingerprint}`
      const cached = cache.get(key)
      if (cached) return forRequest(cached, request)
      if (request.purpose === 'draft' && !continuationEvidenceCanDraft(evidence)) {
        const abstained = buildContinuationAbstainedSnapshot(
          request,
          nowIso(),
          'no-actionable-evidence',
          { fingerprint: evidence.fingerprint }
        )
        remember(key, abstained)
        return abstained
      }
      if (request.purpose === 'title' && !evidence.title.eligible) {
        const abstained = buildContinuationAbstainedSnapshot(
          request,
          nowIso(),
          'title-not-eligible',
          { fingerprint: evidence.fingerprint }
        )
        remember(key, abstained)
        return abstained
      }
      const pending = inFlight.get(key)
      if (pending) return forRequest(await pending, request)
      const created = generate(request, key, evidence).finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, created)
      return forRequest(await created, request)
    },
    applyTitle: async (request) => {
      const issued =
        cache.get(`title:${request.evidenceFingerprint}`) ||
        cache.get(`draft:${request.evidenceFingerprint}`)
      if (
        !issued ||
        issued.status !== 'ready' ||
        issued.title !== request.title ||
        issued.titleSourceMessageId !== request.sourceMessageId ||
        issued.titleSourceFingerprint !== request.sourceFingerprint ||
        issued.titleExpectedCurrent !== request.expectedTitle
      ) {
        return { ok: false, reason: 'title-not-issued' }
      }
      const saved = await deps.applyTitle(request)
      if (!saved) return { ok: false, reason: 'evidence-changed' }
      if (
        saved.threadTitle?.source !== 'local-ai' ||
        saved.threadTitle.evidenceFingerprint !== request.evidenceFingerprint
      ) {
        return { ok: false, reason: 'persistence-rejected' }
      }
      return { ok: true, chat: saved }
    }
  }
}
