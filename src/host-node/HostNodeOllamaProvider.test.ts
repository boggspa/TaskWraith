import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

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
import { normalizeHostProviderRunEvent } from '../host-runtime/HostProviderRunPort'

const OLLAMA_OFFERS = hostProviderOffers('ollama', true)!
const TARGET: HostRunEventTarget = { id: 'client-1' }
// 696b2dc74 replaced the blanket reasoning table with per-model ladders derived
// from resolveOllamaReasoningSupport, and models[0] (qwen3:4b-instruct) is a
// known non-thinking model whose ladder is empty. Bind to a model that actually
// offers one, so the reject-uncatalogued-reasoning assertion below stays
// discriminating instead of passing because every id is refused.
const OLLAMA_MODEL = OLLAMA_OFFERS.models.find((entry) => entry.reasoning.length > 0)!
const OLLAMA_MODEL_ID = OLLAMA_MODEL.modelId
const OLLAMA_REASONING_ID = OLLAMA_MODEL.reasoning[0].reasoningId

function threadFixture(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'ollama',
    modelId: OLLAMA_MODEL_ID,
    reasoningId: OLLAMA_REASONING_ID,
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
  updateRun(input: HostProviderRunUpdate): void {
    void input
  }
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
    const normalized = normalizeHostProviderRunEvent(event)
    if (!normalized) throw new Error('Host profile run event is invalid')
    this.events.push(normalized)
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
import { HOST_OLLAMA_MAX_TOOL_TURNS } from '../host-shared/ollama/OllamaHostToolTurns'

const mockFetchCatalog = vi.mocked(fetchOllamaModelCatalog)
const mockUnloadModel = vi.mocked(unloadOllamaModel)
const mockRunChatLoop = vi.mocked(runOllamaChatLoop)

function mockCatalog(
  models: Array<{
    id: string
    source?: 'local' | 'cloud'
    transport?: 'local-daemon' | 'cloud-daemon' | 'cloud-direct'
    isDefault?: boolean
    disabled?: boolean
    disabledReason?: string
  }>,
  options: { localReachable?: boolean; cloudAuthenticated?: boolean | null } = {}
) {
  const projected = models.map((model) => ({
    id: model.id,
    label: model.id === 'minimax-m3:cloud' ? 'MiniMax M3' : model.id,
    source: model.source ?? ('local' as const),
    transport:
      model.transport ?? (model.source === 'cloud' ? 'cloud-daemon' : ('local-daemon' as const)),
    isCloud: model.source === 'cloud',
    installed: model.source !== 'cloud',
    isDefault: model.isDefault ?? false,
    ...(model.disabled !== undefined ? { disabled: model.disabled } : {}),
    ...(model.disabledReason ? { disabledReason: model.disabledReason } : {})
  }))
  return {
    models: projected,
    localModels: projected.filter((model) => model.source === 'local'),
    cloudModels: projected.filter((model) => model.source === 'cloud'),
    cloud: {
      supported: options.cloudAuthenticated !== undefined,
      enabled: true,
      authenticated: options.cloudAuthenticated ?? null,
      models: projected.filter((model) => model.source === 'cloud')
    },
    localReachable: options.localReachable ?? true
  }
}

function provider(
  resources: HostNodeProviderResourcePort = resourcePort(),
  runPort: FakeRunPort = new FakeRunPort(),
  options: Partial<ConstructorParameters<typeof HostNodeOllamaProvider>[0]> = {}
): HostNodeOllamaProvider {
  return new HostNodeOllamaProvider({
    runPort,
    offers: OLLAMA_OFFERS,
    resources,
    baseUrl: 'http://127.0.0.1:11434',
    ...options
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

  it('coalesces adjacent offer and status reads onto one account/catalog proof', async () => {
    const instance = provider()
    await instance.getOffers()
    await instance.getStatus()
    await instance.getAuthStatus()
    expect(mockFetchCatalog).toHaveBeenCalledTimes(1)
  })

  it('reports an unreachable daemon as a present unavailable row, never an omission', async () => {
    mockFetchCatalog.mockRejectedValue(new Error('connection refused'))
    const status = await provider().getStatus()
    expect(status.providerId).toBe('ollama')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Ollama')
    expect(status.detail).toContain('not reachable')
  })

  it('reports Cloud auth status independently from local daemon reachability', async () => {
    expect((await provider().getAuthStatus()).state).toBe('unknown')
    mockFetchCatalog.mockResolvedValue(
      mockCatalog([{ id: OLLAMA_MODEL_ID }], { cloudAuthenticated: true })
    )
    expect((await provider().getAuthStatus()).state).toBe('authenticated')
  })

  it('rejects a non-canonical auth operation id', async () => {
    await expect(provider().beginAuth(' bad ')).rejects.toBeInstanceOf(
      HostNodeOllamaValidationError
    )
    expect(await provider().cancelAuth()).toBe(false)
  })

  it('offers and launches the exact Ollama Cloud signin handoff without treating spawn as auth', async () => {
    mockFetchCatalog.mockResolvedValue(
      mockCatalog([{ id: OLLAMA_MODEL_ID }], { cloudAuthenticated: false })
    )
    const launchForProvider = vi.fn(async () => ({ providerId: 'ollama', spawned: true as const }))
    const instance = provider(resourcePort(), new FakeRunPort(), {
      terminalLauncher: { launchForProvider }
    })
    await expect(instance.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'ollama:signin', available: true })
    ])
    await expect(instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launchForProvider).toHaveBeenCalledWith('ollama', {
      argv: ['/usr/local/bin/ollama', 'signin']
    })
    expect((await instance.getAuthStatus()).state).toBe('unauthenticated')
  })

  it('refreshes offers across sign-out, sign-in, and sign-out on one provider instance', async () => {
    const local = { id: 'qwen3.5:9b', isDefault: true }
    mockFetchCatalog
      .mockResolvedValueOnce(mockCatalog([local], { cloudAuthenticated: false }))
      .mockResolvedValueOnce(
        mockCatalog(
          [
            { ...local, isDefault: false },
            { id: 'minimax-m3:cloud', source: 'cloud', isDefault: true }
          ],
          { cloudAuthenticated: true }
        )
      )
      .mockResolvedValueOnce(mockCatalog([local], { cloudAuthenticated: false }))
    const instance = provider()

    const signedOut = await instance.getOffers()
    instance['catalogCache'] = undefined
    const signedIn = await instance.getOffers()
    instance['catalogCache'] = undefined
    const signedOutAgain = await instance.getOffers()

    expect(signedOut.models.map((model) => model.modelId)).toEqual(['qwen3.5:9b'])
    expect(signedIn.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'minimax-m3:cloud', default: true })
      ])
    )
    expect(signedOutAgain.models.map((model) => model.modelId)).toEqual(['qwen3.5:9b'])
    expect(signedIn.offerRevision).not.toBe(signedOut.offerRevision)
    expect(signedOutAgain.offerRevision).toBe(signedOut.offerRevision)
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

  // 696b2dc74 replaced the blanket low/medium/high/xhigh table with ladders
  // derived from each model's real capabilities, which narrowed 25 of the 26
  // Ollama rows under selections users had already persisted. Forwarding one
  // unchanged threw here, and the caller turns that into failed(
  // 'run_not_started') — every send on such a chat, permanently.
  it('folds a stale persisted effort onto a stop the narrowed ladder still offers', () => {
    const instance = provider()
    const toggle = OLLAMA_OFFERS.models.find(
      (entry) => entry.reasoning.map((r) => r.reasoningId).join() === 'off,on'
    )!
    // `medium` is off the boolean ladder, but it plainly means "think".
    expect(
      instance.validateThread(threadFixture({ modelId: toggle.modelId, reasoningId: 'medium' }))
        .reasoningId
    ).toBe('on')

    const levels = OLLAMA_OFFERS.models.find(
      (entry) => entry.reasoning.map((r) => r.reasoningId).join() === 'low,medium,high'
    )!
    // `xhigh` sat above every stop this model kept, so it takes the ladder top.
    expect(
      instance.validateThread(threadFixture({ modelId: levels.modelId, reasoningId: 'xhigh' }))
        .reasoningId
    ).toBe('high')
  })

  it('drops a persisted effort for a model the ladder proved cannot think', () => {
    const mute = OLLAMA_OFFERS.models.find((entry) => entry.reasoning.length === 0)!
    const resolved = provider().validateThread(
      threadFixture({ modelId: mute.modelId, reasoningId: 'high' })
    )
    expect(resolved.reasoningId).toBeUndefined()
    expect(resolved.modelId).toBe(mute.modelId)
  })

  it('still refuses an effort that was never a ladder stop, on any model', () => {
    const mute = OLLAMA_OFFERS.models.find((entry) => entry.reasoning.length === 0)!
    expect(() =>
      provider().validateThread(threadFixture({ modelId: mute.modelId, reasoningId: 'ludicrous' }))
    ).toThrow(HostNodeOllamaValidationError)
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

  it('preserves whitespace chunks without publishing invalid empty content events', async () => {
    mockRunChatLoop.mockImplementation(async (options) => {
      let full = ''
      for (const delta of ['\n', 'done', '\n\t', 'verified']) {
        full += delta
        options.onContentDelta?.(delta, full)
      }
      return { content: full, toolCalls: [], toolResults: [] }
    })
    const runPort = new FakeRunPort()
    const result = await provider(resourcePort(), runPort).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'verify the file',
      target: TARGET
    })
    expect(result.status).toBe('completed')
    expect(runPort.events.filter((event) => event.type === 'run.content')).toEqual([
      expect.objectContaining({ text: '\ndone' }),
      expect.objectContaining({ text: '\n\tverified' })
    ])
    expect(runPort.transcripts.at(-1)?.text).toBe('\ndone\n\tverified')
  })

  it('routes a proven direct Cloud model to ollama.com with its base id', async () => {
    const cloudOffers = {
      ...OLLAMA_OFFERS,
      models: [
        {
          modelId: 'minimax-m3:cloud',
          label: 'MiniMax M3',
          available: true,
          default: true,
          reasoning: [
            { reasoningId: 'off', label: 'Off', available: true },
            { reasoningId: 'on', label: 'On', available: true }
          ]
        }
      ]
    }
    mockFetchCatalog.mockResolvedValue(
      mockCatalog(
        [
          {
            id: 'minimax-m3:cloud',
            source: 'cloud',
            transport: 'cloud-direct',
            isDefault: true
          }
        ],
        { localReachable: false, cloudAuthenticated: true }
      )
    )
    mockRunChatLoop.mockResolvedValue({
      content: 'cloud done',
      toolCalls: [],
      toolResults: [],
      usage: {}
    })
    const runPort = new FakeRunPort()
    runPort.thread = threadFixture({
      modelId: 'minimax-m3:cloud',
      reasoningId: 'on'
    })
    const instance = provider(resourcePort(), runPort, {
      offers: cloudOffers,
      cloudApiKey: 'ollama-cloud-key'
    })

    await expect(
      instance.run({
        runId: 'run-cloud',
        threadId: 'thread-1',
        prompt: 'hello cloud',
        target: TARGET
      })
    ).resolves.toMatchObject({ status: 'completed' })
    expect(mockRunChatLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://ollama.com',
        apiKey: 'ollama-cloud-key',
        model: 'minimax-m3'
      })
    )
  })

  it('keeps daemon-authenticated Cloud on the local daemon even when a direct key also exists', async () => {
    const cloudOffers = {
      ...OLLAMA_OFFERS,
      models: [
        {
          modelId: 'minimax-m3:cloud',
          label: 'MiniMax M3',
          available: true,
          default: true,
          reasoning: [
            { reasoningId: 'off', label: 'Off', available: true },
            { reasoningId: 'on', label: 'On', available: true }
          ]
        }
      ]
    }
    mockFetchCatalog.mockResolvedValue(
      mockCatalog(
        [
          {
            id: 'minimax-m3:cloud',
            source: 'cloud',
            transport: 'cloud-daemon',
            isDefault: true
          }
        ],
        { localReachable: true, cloudAuthenticated: true }
      )
    )
    mockRunChatLoop.mockResolvedValue({
      content: 'daemon cloud done',
      toolCalls: [],
      toolResults: [],
      usage: {}
    })
    const runPort = new FakeRunPort()
    runPort.thread = threadFixture({
      modelId: 'minimax-m3:cloud',
      reasoningId: 'on'
    })
    const instance = provider(resourcePort(), runPort, {
      offers: cloudOffers,
      cloudApiKey: 'also-configured'
    })

    await instance.run({
      runId: 'run-daemon-cloud',
      threadId: 'thread-1',
      prompt: 'hello daemon cloud',
      target: TARGET
    })
    expect(mockRunChatLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'minimax-m3:cloud'
      })
    )
    expect(mockRunChatLoop.mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
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
      | ((value: {
          content: string
          toolCalls: []
          toolResults: []
          usage: Record<string, never>
        }) => void)
      | undefined
    const runPromise = new Promise<{
      content: string
      toolCalls: []
      toolResults: []
      usage: Record<string, never>
    }>((resolve) => {
      resolveRun = resolve
    })
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

describe('HostNodeOllamaProvider Host-owned tool tier', () => {
  // The tier resolves every path against the thread's REAL workspace root, so a
  // fixture path that does not exist on disk makes every tool refuse. These
  // tests need a real directory to tell a refused tool from an executed one.
  const workspaces: string[] = []

  function realWorkspace(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollama-host-run-')))
    workspaces.push(root)
    return root
  }

  function runPortAt(root: string, posture?: HostProviderRunThread['posture']): FakeRunPort {
    const runPort = new FakeRunPort()
    runPort.thread = threadFixture({
      workspace: { workspaceId: 'ws-1', canonicalPath: root, canonical: true },
      ...(posture ? { posture } : {})
    })
    return runPort
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchCatalog.mockResolvedValue(mockCatalog([{ id: OLLAMA_MODEL_ID }]))
  })

  afterEach(() => {
    while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true })
  })

  function toolNamesFromCall(index: number): string[] {
    return (mockRunChatLoop.mock.calls[index]![0].tools ?? []).map((tool) => tool.function.name)
  }

  async function runOnce(
    runPort: FakeRunPort,
    options: Partial<ConstructorParameters<typeof HostNodeOllamaProvider>[0]> = {}
  ) {
    return provider(resourcePort(), runPort, options).run({
      runId: 'run-tools',
      threadId: 'thread-1',
      prompt: 'inspect the workspace',
      target: TARGET
    })
  }

  it('advertises only the read tools to a plan-posture seat', async () => {
    mockRunChatLoop.mockResolvedValue({ content: 'read only', toolCalls: [], toolResults: [] })
    await runOnce(new FakeRunPort())
    expect(toolNamesFromCall(0)).toEqual(['read_file', 'list_dir'])
  })

  it('advertises the write tools to a seat whose posture permits edits', async () => {
    mockRunChatLoop.mockResolvedValue({ content: 'can edit', toolCalls: [], toolResults: [] })
    const runPort = runPortAt(realWorkspace(), {
      postureId: 'posture-default',
      approvalMode: 'default',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    })
    await runOnce(runPort)
    expect(toolNamesFromCall(0)).toEqual(['read_file', 'list_dir', 'write_file', 'replace_in_file'])
  })

  it('leaves the advertised set to a caller that injected its own tool port', async () => {
    mockRunChatLoop.mockResolvedValue({ content: 'injected', toolCalls: [], toolResults: [] })
    const executeTool = vi.fn(async () => ({ ok: true, result: 'from the gateway' }))
    await runOnce(new FakeRunPort(), { executeTool })
    expect(toolNamesFromCall(0)).toEqual([])
    expect(mockRunChatLoop.mock.calls[0]![0].executeTool).toBeDefined()
  })

  it('feeds tool results back so the model sees its own tool output', async () => {
    let call = 0
    mockRunChatLoop.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return {
          content: 'let me look',
          toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }],
          toolResults: [{ role: 'tool' as const, content: 'FILE BODY', tool_name: 'read_file' }],
          usage: { promptTokens: 1, completionTokens: 2 }
        }
      }
      return {
        content: 'the file says FILE BODY',
        toolCalls: [],
        toolResults: [],
        usage: { promptTokens: 3, completionTokens: 4 }
      }
    })
    const runPort = new FakeRunPort()
    const result = await runOnce(runPort)

    expect(mockRunChatLoop).toHaveBeenCalledTimes(2)
    const secondTurn = mockRunChatLoop.mock.calls[1]![0].messages
    expect(secondTurn.some((message) => message.role === 'tool')).toBe(true)
    expect(secondTurn.find((message) => message.role === 'tool')?.content).toBe('FILE BODY')
    expect(
      secondTurn.some((message) => message.role === 'assistant' && message.tool_calls?.length === 1)
    ).toBe(true)

    expect(result.status).toBe('completed')
    const assistant = runPort.transcripts.find((entry) => entry.role === 'assistant')
    expect(assistant?.text).toBe('let me look\n\nthe file says FILE BODY')
    expect(runPort.finish?.usage?.inputTokens).toBe(4)
    expect(runPort.finish?.usage?.outputTokens).toBe(6)
  })

  it('executes the Host tier against the thread workspace, not the raw request', async () => {
    const seen: Array<{ ok: boolean; result: string }> = []
    mockRunChatLoop.mockImplementation(async (options) => {
      if (options.executeTool) {
        seen.push(await options.executeTool({ name: 'read_file', arguments: { path: '../out' } }))
      }
      return { content: 'done', toolCalls: [], toolResults: [] }
    })
    await runOnce(new FakeRunPort())
    expect(seen[0]?.ok).toBe(false)
    expect(seen[0]?.result).toContain('escapes the workspace')
  })

  it('finalizes with a spoken ceiling when the same tool keeps failing', async () => {
    mockRunChatLoop.mockImplementation(async (options) => {
      await options.executeTool?.({ name: 'read_file', arguments: { path: '../out' } })
      return {
        content: '',
        toolCalls: [{ name: 'read_file', arguments: { path: '../out' } }],
        toolResults: []
      }
    })
    const runPort = new FakeRunPort()
    const result = await runOnce(runPort)
    expect(result.status).toBe('completed')
    expect(mockRunChatLoop.mock.calls.length).toBeLessThan(HOST_OLLAMA_MAX_TOOL_TURNS)
    const assistant = runPort.transcripts.find((entry) => entry.role === 'assistant')
    expect(assistant?.text).toContain('stopping instead of looping')
  })

  it('bounds a model that keeps calling tools productively forever', async () => {
    mockRunChatLoop.mockImplementation(async (options) => {
      await options.executeTool?.({ name: 'list_dir', arguments: { path: '.' } })
      return {
        content: '',
        toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }],
        toolResults: []
      }
    })
    await runOnce(runPortAt(realWorkspace()))
    expect(mockRunChatLoop).toHaveBeenCalledTimes(HOST_OLLAMA_MAX_TOOL_TURNS)
  })
})

describe('HostNodeOllamaProvider tool trajectory memory', () => {
  const workspaces: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchCatalog.mockResolvedValue(mockCatalog([{ id: OLLAMA_MODEL_ID }]))
  })

  afterEach(() => {
    while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true })
  })

  it('accumulates every tool call in working memory, not just the last one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollama-host-memory-')))
    workspaces.push(root)
    const runPort = new FakeRunPort()
    runPort.thread = threadFixture({
      workspace: { workspaceId: 'ws-1', canonicalPath: root, canonical: true }
    })
    const instance = provider(resourcePort(), runPort)

    mockRunChatLoop.mockImplementation(async (options) => {
      await options.executeTool?.({ name: 'list_dir', arguments: { path: '.' } })
      await options.executeTool?.({ name: 'read_file', arguments: { path: 'missing.txt' } })
      return { content: 'looked around', toolCalls: [], toolResults: [] }
    })
    await instance.run({ runId: 'run-a', threadId: 'thread-1', prompt: 'look', target: TARGET })

    mockRunChatLoop.mockImplementation(async () => ({
      content: 'second',
      toolCalls: [],
      toolResults: []
    }))
    await instance.run({ runId: 'run-b', threadId: 'thread-1', prompt: 'again', target: TARGET })

    const systemMessage = mockRunChatLoop.mock.calls
      .at(-1)![0]
      .messages.find((message) => message.role === 'system')
    expect(systemMessage?.content).toContain('list_dir')
    expect(systemMessage?.content).toContain('read_file')
  })
})
