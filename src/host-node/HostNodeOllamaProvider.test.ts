import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  createHostNodeOllamaProviderFactory,
  HostNodeOllamaProvider,
  HostNodeOllamaValidationError
} from './HostNodeOllamaProvider'
import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import type { HostNodeProviderResourcePort } from './HostNodeProviderResources'
import type {
  HostProviderRunBegin,
  HostProviderRunEvent,
  HostProviderRunFinish,
  HostProviderRunPort,
  HostProviderRunThread,
  HostProviderRunTranscriptAppend,
  HostProviderRunUpdate
} from '../host-runtime/HostProviderRunPort'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'

const OLLAMA_OFFERS = hostProviderOffers('ollama', true)!
const TARGET: HostRunEventTarget = { id: 'client-1' }
const OLLAMA_MODEL_ID = OLLAMA_OFFERS.models[0].modelId

function threadFixture(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'ollama',
    modelId: OLLAMA_MODEL_ID,
    reasoningId: 'high',
    workspace: { workspaceId: 'ws-1', canonicalPath: '/tmp/ws', canonical: true },
    posture: {
      postureId: 'posture-plan',
      approvalMode: 'plan',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    },
    ...overrides
  }
}

class FakeRunPort implements HostProviderRunPort {
  thread: HostProviderRunThread | null = threadFixture()
  readonly transcripts: HostProviderRunTranscriptAppend[] = []
  readonly begins: HostProviderRunBegin[] = []
  readonly events: HostProviderRunEvent[] = []
  finish: HostProviderRunFinish | null = null
  readonly registered: string[] = []
  private cancelCallbacks = new Map<string, () => void>()

  getThread(): HostProviderRunThread | null {
    return this.thread
  }
  appendTranscript(input: HostProviderRunTranscriptAppend): void {
    this.transcripts.push(input)
  }
  beginRun(input: HostProviderRunBegin) {
    this.begins.push(input)
    return { kind: 'started' as const }
  }
  updateRun(_input: HostProviderRunUpdate): void {}
  finishRun(input: HostProviderRunFinish): void {
    this.finish = input
  }
  registerCancel(runId: string, cancel: () => void) {
    this.registered.push(runId)
    this.cancelCallbacks.set(runId, cancel)
    return { kind: 'registered' as const }
  }
  clearCancel(runId: string): void {
    this.cancelCallbacks.delete(runId)
  }
  cancelRun(runId: string): void {
    this.cancelCallbacks.get(runId)?.()
  }
  publishRunEvent(_target: HostRunEventTarget, event: HostProviderRunEvent): void {
    this.events.push(event)
  }
}

function resourcePort(
  overrides: Partial<HostNodeProviderResourcePort> = {}
): HostNodeProviderResourcePort {
  return {
    resolveBinary: async () => ({ binaryPath: '/usr/local/bin/ollama', source: 'path' }),
    getAuthState: async () => 'authenticated' as const,
    getVersion: async () => null,
    ...overrides
  }
}

// Mock the Ollama daemon client
vi.mock('../host-shared/ollama/OllamaDaemonClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../host-shared/ollama/OllamaDaemonClient')>()
  return {
    ...original,
    fetchOllamaModelCatalog: vi.fn(),
    unloadOllamaModel: vi.fn()
  }
})

vi.mock('../host-shared/ollama/OllamaChatLoop', async (importOriginal) => {
  const original = await importOriginal<typeof import('../host-shared/ollama/OllamaChatLoop')>()
  return {
    ...original,
    runOllamaChatLoop: vi.fn()
  }
})

import {
  fetchOllamaModelCatalog,
  unloadOllamaModel
} from '../host-shared/ollama/OllamaDaemonClient'
import { runOllamaChatLoop } from '../host-shared/ollama/OllamaChatLoop'

const mockFetchCatalog = vi.mocked(fetchOllamaModelCatalog)
const mockUnloadModel = vi.mocked(unloadOllamaModel)
const mockRunChatLoop = vi.mocked(runOllamaChatLoop)

function mockCatalog(models: Array<{ id: string; disabled?: boolean; disabledReason?: string }>) {
  return {
    models: models.map((model) => ({
      id: model.id,
      label: model.id,
      source: 'local' as const,
      isCloud: false,
      installed: true,
      isDefault: false,
      ...(model.disabled !== undefined ? { disabled: model.disabled } : {}),
      ...(model.disabledReason ? { disabledReason: model.disabledReason } : {})
    })),
    localModels: [],
    cloudModels: [],
    cloud: { supported: false, enabled: true, authenticated: null, models: [] },
    localReachable: true
  }
}

function provider(
  resources: HostNodeProviderResourcePort = resourcePort(),
  runPort: FakeRunPort = new FakeRunPort()
): HostNodeOllamaProvider {
  return new HostNodeOllamaProvider({
    runPort,
    offers: OLLAMA_OFFERS,
    resources,
    baseUrl: 'http://127.0.0.1:11434'
  })
}

describe('HostNodeOllamaProvider status and auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchCatalog.mockResolvedValue(mockCatalog([{ id: OLLAMA_MODEL_ID }]))
    mockUnloadModel.mockResolvedValue(undefined)
  })

  it('reports a reachable daemon as ready', async () => {
    const status = await provider().getStatus()
    expect(status.providerId).toBe('ollama')
    expect(status.status).toBe('ready')
    expect(status.label).toBe('Ollama')
  })

  it('reports an unreachable daemon as a present unavailable row, never an omission', async () => {
    mockFetchCatalog.mockRejectedValue(new Error('connection refused'))
    const status = await provider().getStatus()
    expect(status.providerId).toBe('ollama')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Ollama')
    expect(status.detail).toContain('not reachable')
  })

  it('reports auth status honestly', async () => {
    expect((await provider().getAuthStatus()).state).toBe('authenticated')
  })

  it('rejects a non-canonical auth operation id', async () => {
    await expect(provider().beginAuth(' bad ')).rejects.toBeInstanceOf(
      HostNodeOllamaValidationError
    )
    expect(await provider().cancelAuth()).toBe(false)
  })

  it('refuses a terminal login because daemon reachability is the auth evidence', async () => {
    await expect(provider().beginAuth('auth-1')).rejects.toThrow(/daemon reachability/i)
  })
})

describe('HostNodeOllamaProvider selection validation', () => {
  it('accepts a catalogued model and rejects anything uncatalogued', () => {
    const instance = provider()
    expect(instance.validateThread(threadFixture()).modelId).toBe(OLLAMA_MODEL_ID)
    expect(() => instance.validateThread(threadFixture({ modelId: 'llama-nope' }))).toThrow(
      HostNodeOllamaValidationError
    )
    expect(() => instance.validateThread(threadFixture({ reasoningId: 'ludicrous' }))).toThrow(
      HostNodeOllamaValidationError
    )
    expect(() => instance.validateThread(threadFixture({ providerId: 'claude' }))).toThrow(
      HostNodeOllamaValidationError
    )
  })
})

describe('HostNodeOllamaProvider run path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchCatalog.mockResolvedValue(mockCatalog([{ id: OLLAMA_MODEL_ID }]))
  })

  it('runs a chat completion and records the full lifecycle', async () => {
    mockRunChatLoop.mockImplementation(async (options) => {
      options.onContentDelta?.('Hello from Ollama', 'Hello from Ollama')
      return {
        content: 'Hello from Ollama',
        toolCalls: [],
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 5 }
      }
    })
    const runPort = new FakeRunPort()
    const instance = provider(resourcePort(), runPort)
    const result = await instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: TARGET
    })
    expect(result.status).toBe('completed')
    expect(runPort.begins).toHaveLength(1)
    expect(runPort.transcripts).toHaveLength(2) // user + assistant
    expect(runPort.events.some((e) => e.type === 'run.started')).toBe(true)
    expect(runPort.events.some((e) => e.type === 'run.content')).toBe(true)
    expect(runPort.finish?.status).toBe('completed')
    expect(runPort.finish?.usage?.inputTokens).toBe(10)
    expect(runPort.finish?.usage?.outputTokens).toBe(5)
  })

  it('records a failed run when the daemon is unreachable', async () => {
    mockFetchCatalog.mockRejectedValue(new Error('connection refused'))
    const runPort = new FakeRunPort()
    const instance = provider(resourcePort(), runPort)
    const result = await instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: TARGET
    })
    expect(result.status).toBe('failed')
    expect(runPort.begins).toHaveLength(1)
    expect(runPort.finish?.status).toBe('failed')
  })

  it('records a failed run when the model is not installed', async () => {
    mockFetchCatalog.mockResolvedValue(mockCatalog([{ id: 'other-model' }]))
    const runPort = new FakeRunPort()
    const instance = provider(resourcePort(), runPort)
    const result = await instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: TARGET
    })
    expect(result.status).toBe('failed')
    expect(runPort.finish?.status).toBe('failed')
  })

  it('cancels an active run exactly once and unloads the model', async () => {
    let resolveRun:
      | ((value: { content: string; toolCalls: []; toolResults: []; usage: {} }) => void)
      | undefined
    const runPromise = new Promise<{ content: string; toolCalls: []; toolResults: []; usage: {} }>(
      (resolve) => {
        resolveRun = resolve
      }
    )
    mockRunChatLoop.mockImplementation(async (options) => {
      options.signal.addEventListener('abort', () => {
        resolveRun?.({ content: '', toolCalls: [], toolResults: [], usage: {} })
      })
      return runPromise
    })
    const runPort = new FakeRunPort()
    const instance = provider(resourcePort(), runPort)
    const run = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: TARGET
    })
    // Let the run start
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(instance.cancel('run-1')).toBe(true)
    expect(instance.cancel('run-1')).toBe(false) // already cancelled
    const result = await run
    expect(result.status).toBe('cancelled')
    expect(mockUnloadModel).toHaveBeenCalled()
  })

  it('shuts down cleanly and unloads the model after a run', async () => {
    mockRunChatLoop.mockResolvedValue({
      content: 'done',
      toolCalls: [],
      toolResults: [],
      usage: {}
    })
    const instance = provider()
    await instance.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hello', target: TARGET })
    await expect(instance.shutdown()).resolves.toBeUndefined()
    expect(mockUnloadModel).toHaveBeenCalled()
  })

  it('thread-isolates session memory across runs', async () => {
    mockRunChatLoop.mockImplementation(async (options) => {
      options.onContentDelta?.('done', 'done')
      return { content: 'done', toolCalls: [], toolResults: [], usage: {} }
    })
    const runPort1 = new FakeRunPort()
    const runPort2 = new FakeRunPort()
    runPort2.thread = threadFixture({ threadId: 'thread-2' })
    const instance1 = provider(resourcePort(), runPort1)
    const instance2 = provider(resourcePort(), runPort2)
    await instance1.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hello', target: TARGET })
    await instance2.run({ runId: 'run-2', threadId: 'thread-2', prompt: 'hello', target: TARGET })
    // Memory is keyed per thread+model, not global.
    expect(instance1['sessionMemoryByThreadModel'].has(`thread-1:${OLLAMA_MODEL_ID}`)).toBe(true)
    expect(instance1['sessionMemoryByThreadModel'].has(`thread-2:${OLLAMA_MODEL_ID}`)).toBe(false)
    expect(instance2['sessionMemoryByThreadModel'].has(`thread-2:${OLLAMA_MODEL_ID}`)).toBe(true)
    expect(instance2['sessionMemoryByThreadModel'].has(`thread-1:${OLLAMA_MODEL_ID}`)).toBe(false)
  })
})

describe('OllamaDaemonClient retry abort', () => {
  it('rejects the retry promise on abort instead of hanging', async () => {
    const { ollamaChatTransport } = await import('../host-shared/ollama/OllamaDaemonClient')
    const controller = new AbortController()
    const stream = ollamaChatTransport({
      baseUrl: 'http://127.0.0.1:1',
      signal: controller.signal,
      request: { model: 'test', messages: [] }
    })
    const iteration = stream.next()
    setTimeout(() => controller.abort(), 20)
    await expect(iteration).rejects.toThrow()
  })
})

describe('HostNodeOllamaProvider factory', () => {
  it('exposes catalog offers and advertises no unresumable interactions', () => {
    const factory = createHostNodeOllamaProviderFactory()
    expect(factory.providerId).toBe('ollama')
    expect(factory.offers.providerId).toBe('ollama')
    expect(factory.offers.models.length).toBeGreaterThan(0)
    expect(factory.supportsApprovals).toBe(false)
    // Pure HTTP chat loop (`runOllamaChatLoop`); no interactive/elicitation
    // channel. There is no question event source; do not flip
    // supportsQuestions without one.
    expect(factory.supportsQuestions).toBe(false)
  })

  it('refuses offers belonging to another provider', () => {
    expect(() =>
      createHostNodeOllamaProviderFactory({ offers: hostProviderOffers('pi', true)! })
    ).toThrow()
  })
})
