import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContinuationProposalSnapshot } from '../../../main/store/types'
import type { ComposerContinuationCheckpoint } from '../lib/composerContinuationCheckpoint'
import { readComposerSuggestionPersonalization } from '../lib/composerSuggestionPersonalization'
import { useComposerSuggestion, type ComposerSuggestionController } from './useComposerSuggestion'

let mountedRoot: Root | null = null
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

afterEach(() => {
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  savedGlobals.clear()
})

function installMinimalRendererDom(): Element {
  for (const key of [
    'window',
    'document',
    'Node',
    'HTMLElement',
    'Element',
    'IS_REACT_ACT_ENVIRONMENT'
  ]) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  class MinimalNode extends EventTarget {
    readonly nodeType: number = 0
  }
  class MinimalHTMLElement extends MinimalNode {
    override readonly nodeType: number = 1
  }
  class MinimalHTMLIFrameElement extends MinimalHTMLElement {}
  const documentTarget = new EventTarget() as EventTarget & Record<string, unknown>
  documentTarget.nodeType = 9
  documentTarget.activeElement = null
  documentTarget.body = null
  documentTarget.documentElement = {}
  const storage = new Map<string, string>()
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = documentTarget
  windowTarget.Node = MinimalNode
  windowTarget.HTMLElement = MinimalHTMLElement
  windowTarget.HTMLIFrameElement = MinimalHTMLIFrameElement
  windowTarget.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  }
  windowTarget.setTimeout = globalThis.setTimeout
  windowTarget.clearTimeout = globalThis.clearTimeout
  documentTarget.defaultView = windowTarget
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    Node: { configurable: true, value: MinimalNode },
    HTMLElement: { configurable: true, value: MinimalHTMLElement },
    Element: { configurable: true, value: MinimalHTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  })
  return Object.assign(new MinimalHTMLElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const checkpoint: ComposerContinuationCheckpoint = {
  schemaVersion: 2,
  id: 'continuation-v2:abc',
  titleId: 'continuation-title-v1:def',
  phase: 'working',
  roundState: 'partial-success',
  hasUserRequest: true,
  hasSettledAssistant: true,
  titleNeedsProposal: false
}

function snapshot(): ContinuationProposalSnapshot {
  return {
    schemaVersion: 2,
    chatId: 'chat-1',
    contextVersion: `${checkpoint.id}:draft`,
    generatedAt: '2026-08-30T00:00:00.000Z',
    status: 'ready',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    proposals: [
      {
        id: 'p1',
        text: '@Reviewer Can you inspect the focused validation failure?',
        intentKind: 'review',
        evidenceIds: ['e0', 'e2'],
        qualityScore: 0.9,
        explanation: 'Grounded in current user intent and validation.',
        target: { participantId: 'seat-review', mentionText: '@Reviewer' }
      },
      {
        id: 'p2',
        text: 'Can you run the focused validation and explain the remaining failure?',
        intentKind: 'verify',
        evidenceIds: ['e0', 'e3'],
        qualityScore: 0.85,
        explanation: 'Grounded in current user intent and run warning.'
      }
    ]
  }
}

describe('useComposerSuggestion', () => {
  it('shows no fallback while pending, advances after retirement, and returns exact target metadata', async () => {
    const container = installMinimalRendererDom()
    let resolveRequest!: (value: ContinuationProposalSnapshot) => void
    const requestContinuationProposal = vi.fn(
      () => new Promise<ContinuationProposalSnapshot>((resolve) => (resolveRequest = resolve))
    )
    let current: ComposerSuggestionController | null = null

    function Harness(): null {
      current = useComposerSuggestion({
        chatId: 'chat-1',
        draft: '',
        busy: false,
        checkpoint,
        requestContinuationProposal
      })
      return null
    }
    const readCurrent = (): ComposerSuggestionController => {
      if (!current) throw new Error('Composer suggestion hook did not render')
      return current
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    expect(readCurrent().ghostText).toBeNull()

    resolveRequest(snapshot())
    await settleEffects()
    expect(readCurrent().ghostText).toContain('@Reviewer')
    let accepted: ReturnType<ComposerSuggestionController['accept']> = null
    act(() => {
      accepted = readCurrent().accept()
    })
    expect(accepted).toMatchObject({
      targetParticipantId: 'seat-review',
      targetMentionText: '@Reviewer'
    })
    expect(readCurrent().ghostText).toContain('run the focused validation')

    act(() => readCurrent().dismiss())
    expect(readCurrent().ghostText).toBeNull()
  })

  it('shows nothing for abstention and never synthesizes a legacy template', async () => {
    const container = installMinimalRendererDom()
    let current: ComposerSuggestionController | null = null
    function Harness(): null {
      current = useComposerSuggestion({
        chatId: 'chat-1',
        draft: '',
        busy: false,
        checkpoint,
        requestContinuationProposal: async (request) => ({
          schemaVersion: 2,
          chatId: request.chatId,
          contextVersion: request.contextVersion,
          generatedAt: '2026-08-30T00:00:00.000Z',
          status: 'abstained',
          proposals: []
        })
      })
      return null
    }
    const readCurrent = (): ComposerSuggestionController => {
      if (!current) throw new Error('Composer suggestion hook did not render')
      return current
    }
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    expect(readCurrent().ghostText).toBeNull()
  })

  it('does not refetch a draft for an equivalent checkpoint object', async () => {
    const container = installMinimalRendererDom()
    let liveCheckpoint = { ...checkpoint }
    const requestContinuationProposal = vi.fn(async (request) => ({
      ...snapshot(),
      chatId: request.chatId,
      contextVersion: request.contextVersion
    }))

    function Harness(): null {
      useComposerSuggestion({
        chatId: 'chat-1',
        draft: '',
        busy: false,
        checkpoint: liveCheckpoint,
        requestContinuationProposal
      })
      return null
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(1)

    liveCheckpoint = { ...liveCheckpoint }
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(1)

    liveCheckpoint = { ...liveCheckpoint, id: 'continuation-v2:changed' }
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(2)
  })

  it('gates and deduplicates title generation with the AutoDraft setting', async () => {
    const container = installMinimalRendererDom()
    let liveEnabled = false
    let liveCheckpoint = { ...checkpoint, titleNeedsProposal: true }
    const onTitleProposal = vi.fn()
    const requestContinuationProposal = vi.fn(async (request) => ({
      schemaVersion: 2 as const,
      chatId: request.chatId,
      contextVersion: request.contextVersion,
      generatedAt: '2026-08-30T00:00:00.000Z',
      status: 'abstained' as const,
      proposals: []
    }))

    function Harness(): null {
      useComposerSuggestion({
        chatId: 'chat-1',
        draft: '',
        busy: true,
        checkpoint: liveCheckpoint,
        requestContinuationProposal,
        onTitleProposal,
        enabled: liveEnabled
      })
      return null
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    expect(requestContinuationProposal).not.toHaveBeenCalled()

    liveEnabled = true
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(1)

    liveCheckpoint = { ...liveCheckpoint }
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(1)

    liveCheckpoint = { ...liveCheckpoint, titleId: 'continuation-title-v1:changed' }
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(requestContinuationProposal).toHaveBeenCalledTimes(2)
  })

  it('forgets an accepted suggestion after its draft is deleted', async () => {
    const container = installMinimalRendererDom()
    let liveDraft = ''
    let current: ComposerSuggestionController | null = null
    const requestContinuationProposal = vi.fn(async (request) => ({
      ...snapshot(),
      chatId: request.chatId,
      contextVersion: request.contextVersion
    }))

    function Harness(): null {
      current = useComposerSuggestion({
        chatId: 'chat-1',
        draft: liveDraft,
        busy: false,
        checkpoint,
        requestContinuationProposal
      })
      return null
    }
    const readCurrent = (): ComposerSuggestionController => {
      if (!current) throw new Error('Composer suggestion hook did not render')
      return current
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    const accepted = readCurrent().accept()
    expect(accepted?.text).toBeTruthy()

    liveDraft = accepted!.text
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    liveDraft = ''
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()

    liveDraft = 'Ask about an unrelated follow-up'
    await act(async () => mountedRoot?.render(createElement(Harness)))
    act(() => readCurrent().observeSentDraft(liveDraft))
    const profile = readComposerSuggestionPersonalization('chat-1')
    expect(profile.style.sentPrompts).toBe(1)
    expect(profile.style.acceptedSuggestionSends).toBe(0)
    expect(profile.style.editedAcceptedSuggestionSends).toBe(0)
  })

  it('does not count a ghost hidden by busy state as a later dismissal', async () => {
    const container = installMinimalRendererDom()
    let liveDraft = ''
    let liveBusy = false
    const requestContinuationProposal = vi.fn(async (request) => ({
      ...snapshot(),
      chatId: request.chatId,
      contextVersion: request.contextVersion
    }))

    function Harness(): null {
      useComposerSuggestion({
        chatId: 'chat-1',
        draft: liveDraft,
        busy: liveBusy,
        checkpoint,
        requestContinuationProposal
      })
      return null
    }

    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    await settleEffects()
    expect(
      readComposerSuggestionPersonalization('chat-1').byTrigger['semantic-continuation']
    ).toMatchObject({ shown: 1, dismissed: 0 })

    liveBusy = true
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    liveBusy = false
    liveDraft = 'A different request'
    await act(async () => mountedRoot?.render(createElement(Harness)))
    await settleEffects()
    expect(
      readComposerSuggestionPersonalization('chat-1').byTrigger['semantic-continuation']?.dismissed
    ).toBe(0)
  })
})
