import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_WARNING_PROVIDER_SOURCE_NOT_READY,
  type HostSnapshot
} from '../../../shared/hostProtocol'
import { HostProjectionProvider } from '../components/HostProjectionProvider'
import { HostProjectionStore, type HostProjectionState } from '../lib/host/HostProjectionStore'
import {
  antigravityGeminiApiSecretIdentityIsConfigured,
  antigravityGeminiApiSecretRefreshIdentity,
  configuredProviderSnapshotFromHostProjection,
  isDispatchableProviderForRun,
  ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT,
  notifyAntigravityGeminiApiSecretMutation,
  sanitizeConfiguredProviderSnapshot,
  useConfiguredProviderSnapshot,
  useAntigravityGeminiApiSecretRefreshIdentity,
  type ConfiguredProviderSnapshot
} from './useConfiguredProviderSnapshot'

function hostSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: 1,
    projectionVersion: 1,
    generatedAt: '2026-08-07T12:00:00.000Z',
    generation: 1,
    cursor: 1,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: {},
    ...overrides
  } as unknown as HostSnapshot
}

function hostState(overrides: Partial<HostProjectionState> = {}): HostProjectionState {
  return { status: 'idle', ...overrides }
}

let mountedRoot: Root | null = null
let savedWindow: PropertyDescriptor | undefined
let savedDocument: PropertyDescriptor | undefined
let savedNode: PropertyDescriptor | undefined
let savedHTMLElement: PropertyDescriptor | undefined
let savedElement: PropertyDescriptor | undefined
let savedActEnvironment: PropertyDescriptor | undefined

afterEach(() => {
  vi.useRealTimers()
  act(() => mountedRoot?.unmount())
  mountedRoot = null
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow)
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument)
  if (savedNode) Object.defineProperty(globalThis, 'Node', savedNode)
  if (savedHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', savedHTMLElement)
  if (savedElement) Object.defineProperty(globalThis, 'Element', savedElement)
  else delete (globalThis as Record<string, unknown>).Element
  if (savedActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment)
  } else {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  }
})

function installMinimalRendererDom(): Element {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  savedNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  savedElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
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
  const windowTarget = new EventTarget() as EventTarget & Record<string, unknown>
  windowTarget.document = documentTarget
  windowTarget.Node = MinimalNode
  windowTarget.HTMLElement = MinimalHTMLElement
  windowTarget.HTMLIFrameElement = MinimalHTMLIFrameElement
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
    lastChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
}

describe('successful Gemini API mutation refresh signal', () => {
  it('emits the same nonsecret event for successful set and clear paths', () => {
    const originalWindow = globalThis.window
    const eventTarget = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: eventTarget
    })
    const received: Event[] = []
    eventTarget.addEventListener(ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT, (event) => {
      received.push(event)
    })

    try {
      notifyAntigravityGeminiApiSecretMutation()
      notifyAntigravityGeminiApiSecretMutation()
      expect(received).toHaveLength(2)
      expect(JSON.stringify(received)).not.toContain('secret')
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      })
    }
  })

  it('updates the mounted snapshot refresh identity immediately for set and clear events', async () => {
    const container = installMinimalRendererDom()
    let renderedIdentity = ''
    function Harness(): null {
      renderedIdentity = useAntigravityGeminiApiSecretRefreshIdentity()
      return null
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAntigravityGeminiApiSecretStatus: () => new Promise(() => undefined)
      }
    })
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(createElement(Harness))
    })
    expect(renderedIdentity).toBe(':mutation-0')
    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedIdentity).toBe(':mutation-1')
    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedIdentity).toBe(':mutation-2')
  })

  it('withdraws and reloads mounted provider rows from Host on both mutations', async () => {
    const container = installMinimalRendererDom()
    let renderedSnapshot: ConfiguredProviderSnapshot = { ready: false, providerIds: [] }
    const pendingReloads: Array<(value: HostSnapshot) => void> = []
    let snapshotCalls = 0
    const antigravitySnapshot = hostSnapshot({
      providers: [
        {
          providerId: 'antigravity',
          displayProvider: 'AntiGravity',
          shortCode: 'AG',
          available: true,
          modelId: 'agy-model',
          modelLabel: 'AGY model'
        }
      ]
    })
    const store = new HostProjectionStore({
      fetchSnapshot: () => {
        snapshotCalls += 1
        if (snapshotCalls === 1) {
          return Promise.resolve(antigravitySnapshot)
        }
        return new Promise((resolve) => pendingReloads.push(resolve))
      }
    })
    function Harness(): null {
      const identity = useAntigravityGeminiApiSecretRefreshIdentity()
      const snapshot = useConfiguredProviderSnapshot(identity)
      renderedSnapshot = snapshot
      return null
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAntigravityGeminiApiSecretStatus: () => new Promise(() => undefined)
      }
    })
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(
        // eslint-disable-next-line react/no-children-prop -- props.children required by HostProjectionProviderProps for tsc
        createElement(HostProjectionProvider, {
          store,
          children: createElement(Harness)
        })
      )
    })
    // useHostProjection refreshes on mount; settle the first Host fetch.
    await act(async () => {
      await Promise.resolve()
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])
    expect(renderedSnapshot.modelsByProvider?.antigravity?.[0]?.id).toBe('agy-model')

    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedSnapshot.providerIds).toEqual([])
    await act(async () => {
      pendingReloads.shift()?.(antigravitySnapshot)
      await Promise.resolve()
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])

    act(() => notifyAntigravityGeminiApiSecretMutation())
    expect(renderedSnapshot.providerIds).toEqual([])
    await act(async () => {
      pendingReloads.shift()?.(antigravitySnapshot)
      await Promise.resolve()
    })
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])
  })

  it('settles provider_source_not_ready into AntiGravity without a secret mutation', async () => {
    // Wave 5c replaced the IPC settle poll with a one-shot Host refresh. If
    // discovery is still not ready on that first pull, AntiGravity stays
    // missing for the session unless we ask Host again — live providers still
    // paint from LIVE_SELECTABLE_PROVIDER_IDS, so only the conditional lane
    // disappears. This must recover without an AG secret mutation.
    vi.useFakeTimers()
    const container = installMinimalRendererDom()
    let renderedSnapshot: ConfiguredProviderSnapshot = { ready: false, providerIds: [] }
    let snapshotCalls = 0
    const notReadySnapshot = hostSnapshot({
      providers: [],
      warnings: [
        {
          warningId: `${HOST_WARNING_PROVIDER_SOURCE_NOT_READY}:providers`,
          severity: 'info',
          code: HOST_WARNING_PROVIDER_SOURCE_NOT_READY,
          message: 'provider discovery has not completed',
          at: 1
        }
      ]
    })
    const antigravitySnapshot = hostSnapshot({
      providers: [
        {
          providerId: 'antigravity',
          displayProvider: 'AntiGravity',
          shortCode: 'AG',
          available: true,
          modelId: 'agy-model',
          modelLabel: 'AGY model'
        }
      ]
    })
    const store = new HostProjectionStore({
      fetchSnapshot: () => {
        snapshotCalls += 1
        return Promise.resolve(snapshotCalls === 1 ? notReadySnapshot : antigravitySnapshot)
      }
    })
    function Harness(): null {
      renderedSnapshot = useConfiguredProviderSnapshot()
      return null
    }
    await act(async () => {
      mountedRoot = createRoot(container)
      mountedRoot.render(
        // eslint-disable-next-line react/no-children-prop -- props.children required by HostProjectionProviderProps for tsc
        createElement(HostProjectionProvider, {
          store,
          children: createElement(Harness)
        })
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(renderedSnapshot).toEqual({ ready: false, providerIds: [] })
    expect(snapshotCalls).toBeGreaterThanOrEqual(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
    })
    expect(snapshotCalls).toBeGreaterThanOrEqual(2)
    expect(renderedSnapshot.providerIds).toEqual(['antigravity'])
    expect(renderedSnapshot.modelsByProvider?.antigravity?.[0]?.id).toBe('agy-model')
    vi.useRealTimers()
  })
})

describe('antigravityGeminiApiSecretRefreshIdentity', () => {
  it('projects only nonsecret configured and generation state', () => {
    expect(
      antigravityGeminiApiSecretRefreshIdentity({
        configured: true,
        updatedAt: '2026-07-23T15:00:00.000Z',
        apiKey: 'secret'
      })
    ).toBe('configured:2026-07-23T15:00:00.000Z')
    expect(
      antigravityGeminiApiSecretRefreshIdentity({
        configured: false,
        ciphertext: 'secret'
      })
    ).toBe('unconfigured:')
  })

  // App.tsx admits AntiGravity when EITHER lane is consented; reading only the
  // agy opt-in used to strip the provider out of every renderer surface for
  // key-only users.
  it('reports key-lane admission from the polled identity, failing closed', () => {
    expect(
      antigravityGeminiApiSecretIdentityIsConfigured(
        'configured:2026-07-23T15:00:00.000Z:mutation-0'
      )
    ).toBe(true)
    expect(antigravityGeminiApiSecretIdentityIsConfigured('configured::mutation-3')).toBe(true)
    for (const identity of [
      'unconfigured::mutation-0',
      'unavailable:mutation-1',
      ':mutation-0',
      ''
    ]) {
      expect(antigravityGeminiApiSecretIdentityIsConfigured(identity)).toBe(false)
    }
  })
})

describe('isDispatchableProviderForRun', () => {
  it('admits the live set regardless of AntiGravity admission', () => {
    for (const provider of ['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama']) {
      expect(isDispatchableProviderForRun(provider, false)).toBe(true)
      expect(isDispatchableProviderForRun(provider, true)).toBe(true)
    }
  })

  it('admits antigravity only when a lane is admitted', () => {
    // The regression this guards: the picker offered AntiGravity via the
    // snapshot union while every App dispatch gate still used the bare live-set
    // predicate, so a selected AntiGravity model physically could not send.
    expect(isDispatchableProviderForRun('antigravity', true)).toBe(true)
    expect(isDispatchableProviderForRun('antigravity', false)).toBe(false)
  })

  it('keeps retired and unknown providers out even when antigravity is admitted', () => {
    for (const provider of ['gemini', 'made-up', '', null, undefined]) {
      expect(isDispatchableProviderForRun(provider, true)).toBe(false)
    }
  })

  it('fails closed on a non-boolean admission flag', () => {
    expect(isDispatchableProviderForRun('antigravity', 'yes' as unknown as boolean)).toBe(false)
    expect(isDispatchableProviderForRun('antigravity', 1 as unknown as boolean)).toBe(false)
  })
})

describe('sanitizeConfiguredProviderSnapshot', () => {
  it('keeps unique live providers in discovery order', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['claude', 'gemini', 'claude', 'cursor', 'unknown']
      })
    ).toEqual({ ready: true, providerIds: ['claude', 'cursor'] })
  })

  it('returns a pending empty snapshot for malformed input', () => {
    expect(sanitizeConfiguredProviderSnapshot(null)).toEqual({
      ready: false,
      providerIds: []
    })
    expect(sanitizeConfiguredProviderSnapshot({ ready: 'yes', providerIds: 'codex' })).toEqual({
      ready: false,
      providerIds: []
    })
  })

  it('admits AntiGravity only with a nonempty validated cached model list', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity']
      })
    ).toEqual({ ready: true, providerIds: [] })

    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [
            { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
            { id: 'gemini-3.5-pro', label: 'Duplicate is ignored' },
            { id: '', label: 'Ignored' }
          ]
        }
      })
    ).toEqual({
      ready: true,
      providerIds: ['antigravity'],
      modelsByProvider: {
        antigravity: [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]
      }
    })
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5c Phase 1 — Host projection → configured snapshot honesty  */
/* ------------------------------------------------------------------ */

describe('configuredProviderSnapshotFromHostProjection · honesty pins', () => {
  it('RED: Host not live → not ready (never a confident empty ready panel)', () => {
    for (const status of ['idle', 'loading', 'unavailable'] as const) {
      expect(
        configuredProviderSnapshotFromHostProjection(
          hostState({
            status,
            projection: {
              freshness: 'live',
              providers: [
                {
                  providerId: 'claude',
                  displayProvider: 'Claude',
                  shortCode: 'CL',
                  available: true
                }
              ],
              warningCodes: []
            } as never
          })
        )
      ).toEqual({ ready: false, providerIds: [] })
    }
  })

  it('RED: cached projection is not live authority', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'cached',
            providers: [
              {
                providerId: 'codex',
                displayProvider: 'Codex',
                shortCode: 'CX',
                available: true
              }
            ],
            warningCodes: []
          } as never
        })
      )
    ).toEqual({ ready: false, providerIds: [] })
  })

  it('RED: provider_source_not_ready → not ready (empty is not a measured zero)', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'live',
            providers: [],
            warningCodes: [HOST_WARNING_PROVIDER_SOURCE_NOT_READY]
          } as never
        })
      )
    ).toEqual({ ready: false, providerIds: [] })
  })

  it('genuine empty after ready → ready with empty providerIds', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'live',
            providers: [],
            warningCodes: []
          } as never
        })
      )
    ).toEqual({ ready: true, providerIds: [] })
  })

  it('maps admitted Host rows to providerIds; wire available means configured', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'live',
            providers: [
              {
                providerId: 'claude',
                displayProvider: 'Claude',
                shortCode: 'CL',
                available: true
              },
              {
                providerId: 'codex',
                displayProvider: 'Codex',
                shortCode: 'CX',
                available: false
              },
              {
                providerId: 'claude',
                displayProvider: 'Claude',
                shortCode: 'CL',
                available: true,
                modelId: 'sonnet'
              }
            ],
            warningCodes: []
          } as never
        })
      )
    ).toEqual({ ready: true, providerIds: ['claude'] })
  })

  it('collapses multi-model Host rows into modelsByProvider for AntiGravity', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'live',
            providers: [
              {
                providerId: 'antigravity',
                displayProvider: 'AntiGravity',
                shortCode: 'AG',
                available: true,
                modelId: 'gemini-3.5-pro',
                modelLabel: 'Gemini 3.5 Pro'
              },
              {
                providerId: 'antigravity',
                displayProvider: 'AntiGravity',
                shortCode: 'AG',
                available: true,
                modelId: 'gemini-flash',
                modelLabel: 'Flash'
              }
            ],
            warningCodes: []
          } as never
        })
      )
    ).toEqual({
      ready: true,
      providerIds: ['antigravity'],
      modelsByProvider: {
        antigravity: [
          { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
          { id: 'gemini-flash', label: 'Flash' }
        ]
      }
    })
  })

  it('strips retired/unknown provider ids even if Host projected them', () => {
    expect(
      configuredProviderSnapshotFromHostProjection(
        hostState({
          status: 'live',
          projection: {
            freshness: 'live',
            providers: [
              {
                providerId: 'gemini',
                displayProvider: 'Gemini',
                shortCode: 'GE',
                available: true
              },
              {
                providerId: 'cursor',
                displayProvider: 'Cursor',
                shortCode: 'CU',
                available: true
              }
            ],
            warningCodes: []
          } as never
        })
      )
    ).toEqual({ ready: true, providerIds: ['cursor'] })
  })
})
