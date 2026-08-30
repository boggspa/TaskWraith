import type {
  ChatRecord,
  ContinuationProposalPurpose,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  ContinuationTitleApplyRequest
} from '../store/types'
import type { ComposerContinuationProposalService } from './ComposerContinuationProposalService'

export interface ComposerContinuationPrefetchDeps {
  service: ComposerContinuationProposalService
  isEnabled?: () => boolean | Promise<boolean>
  beforePrefetch?: (chatId: string) => void | Promise<void>
  afterTitleApplied?: (chat: ChatRecord) => void | Promise<void>
  schedule?: (run: () => void) => void
  onError?: (chatId: string, error: unknown) => void
}

export interface ComposerContinuationPrefetch {
  observe: (chatId: string) => void
  drainNow: () => Promise<void>
}

let persistedChatObserver: ((chatId: string) => void) | null = null

export function installComposerContinuationPersistObserver(
  observer: ((chatId: string) => void) | null
): void {
  persistedChatObserver = observer
}

export function observeComposerContinuationPersisted(chatId: string): void {
  persistedChatObserver?.(chatId)
}

function prefetchRequest(
  chatId: string,
  purpose: ContinuationProposalPurpose
): ContinuationProposalRequest {
  return {
    schemaVersion: 2,
    chatId,
    contextVersion: `main-prefetch:${purpose}`,
    purpose
  }
}

function titleApplyRequest(
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

export function createComposerContinuationPrefetch(
  deps: ComposerContinuationPrefetchDeps
): ComposerContinuationPrefetch {
  const schedule = deps.schedule ?? queueMicrotask
  const queuedChatIds = new Set<string>()
  let scheduled = false
  let drainInFlight: Promise<void> | null = null

  const prefetchOne = async (chatId: string): Promise<void> => {
    if (deps.isEnabled && !(await deps.isEnabled())) return
    await deps.beforePrefetch?.(chatId)

    const [titleSnapshot] = await Promise.all([
      deps.service.propose(prefetchRequest(chatId, 'title')),
      deps.service.propose(prefetchRequest(chatId, 'draft'))
    ])
    const applyRequest = titleApplyRequest(chatId, titleSnapshot)
    if (applyRequest) {
      const result = await deps.service.applyTitle(applyRequest)
      if (result.ok && result.chat) await deps.afterTitleApplied?.(result.chat)
    }
  }

  const runDrain = async (): Promise<void> => {
    while (queuedChatIds.size > 0) {
      const chatIds = [...queuedChatIds]
      queuedChatIds.clear()
      for (const chatId of chatIds) {
        try {
          await prefetchOne(chatId)
        } catch (error) {
          deps.onError?.(chatId, error)
        }
      }
    }
  }

  const drainNow = (): Promise<void> => {
    scheduled = false
    if (drainInFlight) return drainInFlight
    const running = runDrain().finally(() => {
      drainInFlight = null
      if (queuedChatIds.size > 0 && !scheduled) {
        scheduled = true
        schedule(() => void drainNow())
      }
    })
    drainInFlight = running
    return running
  }

  return {
    observe: (chatId) => {
      if (!chatId.trim()) return
      queuedChatIds.add(chatId)
      if (scheduled || drainInFlight) return
      scheduled = true
      schedule(() => void drainNow())
    },
    drainNow
  }
}
