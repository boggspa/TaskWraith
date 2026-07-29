import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import {
  chunkTextForTest,
  chunkThoughtTextForTest,
  filterGeminiApiMcpToolsForProfile,
  tryRunGeminiApi,
  type GeminiApiProviderDeps
} from './GeminiApiProvider'
import { gatewayToolDefinitions } from './mcp/McpToolGateway'
import { AppStore } from './store'
import type { AgentRunPayload, AgentRunRoute } from './run/AgentRunTypes'
import type {
  AppSettings,
  ChatMessage,
  ChatRecord,
  GeminiAuthProfile,
  UsageRecord
} from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-gemini-api-provider-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

// Lightweight assertions about the event stream the provider emits.
// Tests use a single shared `sender` stub plus capture closures wired
// through `deps` so they can introspect the calls without spinning up
// a real WebContents.
type SendLineCall = {
  provider: string
  payload: any
  route: AgentRunRoute | null | undefined
}
type SendErrorCall = { provider: string; error: string }
type SendExitCall = { provider: string; code: number | null }

function makeDeps(overrides: {
  settings?: Partial<AppSettings>
  profiles?: GeminiAuthProfile[]
  defaultProfileId?: string | null
  decrypt?: (stored?: string | null) => string | null
  loadSdk?: () => Promise<any | null>
  // Phase M1 Step 3 deps (optional in tests so existing Step-2 tests
  // can omit them and still satisfy the interface — the defaults
  // disable function calling).
  mcpTools?: ReadonlyArray<{ name?: string; description?: string; inputSchema?: unknown }>
  executeMcpTool?: (
    toolName: string,
    args: unknown,
    route: AgentRunRoute | null
  ) => Promise<{ text: string; isError?: boolean }>
  prepareToolContext?: (
    sender: Electron.WebContents,
    payload: AgentRunPayload,
    route: AgentRunRoute,
    sessionId: string
  ) => Promise<void> | void
  // Phase M1 Step 5 deps (optional — defaults to no chat / no save so
  // existing tests that don't care about history get a clean single-turn
  // request).
  getChat?: (chatId: string) => ChatRecord | null | undefined
  saveChatLinkedSessionId?: (chatId: string, sessionId: string) => void
  // Phase M1 Step 7 deps (optional — default omitted so existing tests
  // skip the image-mounting branch entirely; a test that wants to drive
  // image handling supplies its own reader).
  readImageFile?: (imagePath: string) => Promise<Buffer | null>
  // Phase M1 Step 8 deps (optional — default omitted so existing tests
  // don't accumulate phantom usage rows; tests that exercise usage
  // tracking either supply their own or assert on the captured list).
  recordUsage?: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => void
  // Phase M1 Step 9 deps (optional — default captures invocations into
  // `migrationNotices` so tests can assert presence/absence by reading
  // that array directly).
  appendChatSystemMessage?: (chatId: string, message: ChatMessage) => void
  runAdmitted?: (runId: string | undefined) => boolean
  runPersistenceAuthorized?: (provider: string, route: AgentRunRoute) => boolean
  beginTransportOperation?: GeminiApiProviderDeps['beginTransportOperation']
}): {
  deps: GeminiApiProviderDeps
  lines: SendLineCall[]
  errors: SendErrorCall[]
  exits: SendExitCall[]
  finishes: Array<{ runId: string | undefined; status: string }>
  toolCalls: Array<{ toolName: string; args: unknown; route: AgentRunRoute | null }>
  toolContextPreparations: Array<{
    payload: AgentRunPayload
    route: AgentRunRoute
    sessionId: string
  }>
  sessionSaves: Array<{ chatId: string; sessionId: string }>
  usageRecords: Array<Omit<UsageRecord, 'id' | 'timestamp'>>
  migrationNotices: Array<{ chatId: string; message: ChatMessage }>
} {
  const lines: SendLineCall[] = []
  const errors: SendErrorCall[] = []
  const exits: SendExitCall[] = []
  const finishes: Array<{ runId: string | undefined; status: string }> = []
  const toolCalls: Array<{ toolName: string; args: unknown; route: AgentRunRoute | null }> = []
  const toolContextPreparations: Array<{
    payload: AgentRunPayload
    route: AgentRunRoute
    sessionId: string
  }> = []
  const sessionSaves: Array<{ chatId: string; sessionId: string }> = []
  const usageRecords: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
  const migrationNotices: Array<{ chatId: string; message: ChatMessage }> = []
  const baseSettings: AppSettings = {
    geminiApiRuntime: 'auto',
    geminiAuthProfiles: overrides.profiles || [],
    defaultGeminiAuthProfileId: overrides.defaultProfileId ?? null,
    // Fields below are required by AppSettings but not consumed by the
    // provider; pick safe defaults so we don't have to import the full
    // default settings object.
    storeLocalChatHistory: true,
    storeRawEvents: false,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    appearanceMode: 'soft_glass',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    userBubbleColor: 'system',
    promptSurfaceStyle: 'liquid_glass',
    composerStyle: 'default',
    funFxEnabled: false,
    funFxMode: 'cinematic',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
      intensity: 'cinematic'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: false,
    inspectorWidth: 380,
    sidebarWidth: 260,
    ...(overrides.settings || {})
  } as AppSettings

  const deps: GeminiApiProviderDeps = {
    sendAgentCompatLine: (_sender, provider, payload, route) => {
      lines.push({ provider, payload, route })
    },
    sendAgentCompatError: (_sender, provider, error) => {
      errors.push({ provider, error })
    },
    sendAgentCompatExit: (_sender, provider, code) => {
      exits.push({ provider, code })
    },
    runManager: {
      attachAbortController: () => undefined,
      canAdmitTransport: (runId) => overrides.runAdmitted?.(runId) ?? true,
      confirmTerminalStatus: () => undefined,
      get: (runId) => {
        if (!runId) return undefined
        const latestFinish = finishes[finishes.length - 1]
        return {
          runId,
          status: latestFinish?.status ?? 'running'
        } as any
      },
      getClaimedTerminalStatus: () => undefined,
      finish: (runId, status) => {
        finishes.push({ runId, status })
        return undefined
      }
    },
    isRunPersistenceAuthorized: overrides.runPersistenceAuthorized,
    beginTransportOperation: overrides.beginTransportOperation,
    getSettings: () => baseSettings,
    getGeminiAuthProfiles: () => overrides.profiles || [],
    getDefaultGeminiAuthProfileId: () => overrides.defaultProfileId ?? null,
    decryptApiKey: overrides.decrypt ?? ((stored) => (stored ? `decrypted:${stored}` : null)),
    getMcpToolDefinitions: () => overrides.mcpTools || [],
    executeMcpTool: async (toolName, args, route) => {
      toolCalls.push({ toolName, args, route })
      if (overrides.executeMcpTool) {
        return overrides.executeMcpTool(toolName, args, route)
      }
      // Default: pretend the tool returned an empty success. Tests
      // that exercise the tool-calling loop will override this.
      return { text: '', isError: false }
    },
    prepareToolContext: overrides.prepareToolContext
      ? (sender, payload, route, sessionId) => {
          toolContextPreparations.push({ payload, route, sessionId })
          return overrides.prepareToolContext!(sender, payload, route, sessionId)
        }
      : undefined,
    getChat: overrides.getChat,
    saveChatLinkedSessionId: overrides.saveChatLinkedSessionId
      ? (chatId, sessionId) => {
          sessionSaves.push({ chatId, sessionId })
          overrides.saveChatLinkedSessionId!(chatId, sessionId)
        }
      : (chatId, sessionId) => {
          sessionSaves.push({ chatId, sessionId })
        },
    readImageFile: overrides.readImageFile,
    recordUsage: overrides.recordUsage
      ? (entry) => {
          usageRecords.push(entry)
          overrides.recordUsage!(entry)
        }
      : (entry) => {
          usageRecords.push(entry)
        },
    appendChatSystemMessage: overrides.appendChatSystemMessage
      ? (chatId, message) => {
          migrationNotices.push({ chatId, message })
          overrides.appendChatSystemMessage!(chatId, message)
        }
      : (chatId, message) => {
          migrationNotices.push({ chatId, message })
        },
    loadSdk: overrides.loadSdk
  }
  return {
    deps,
    lines,
    errors,
    exits,
    finishes,
    toolCalls,
    toolContextPreparations,
    sessionSaves,
    usageRecords,
    migrationNotices
  }
}

function makeApiKeyProfile(overrides: Partial<GeminiAuthProfile> = {}): GeminiAuthProfile {
  return {
    id: 'profile-1',
    label: 'Default',
    kind: 'api-key',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    encryptedApiKey: 'encrypted-key',
    ...overrides
  }
}

const stubEvent = {
  sender: { send: () => undefined }
} as unknown as Electron.IpcMainInvokeEvent

const basePayload: AgentRunPayload = {
  provider: 'gemini',
  scope: 'workspace',
  prompt: 'Hello Gemini',
  workspace: '/tmp/workspace',
  appRunId: 'run-1',
  appChatId: 'chat-1'
}
const baseRoute: AgentRunRoute = { appRunId: 'run-1', appChatId: 'chat-1' }

/** Build a fake @google/genai SDK that yields the provided chunks. */
function fakeSdk(chunks: any[], options: { throwOn?: 'init' | 'stream' } = {}) {
  let constructed = 0
  const generator = async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  }
  return async () => ({
    GoogleGenAI: class FakeClient {
      models: any
      constructor() {
        constructed++
        if (options.throwOn === 'init') throw new Error('init failed')
        this.models = {
          generateContentStream: async () => {
            if (options.throwOn === 'stream') throw new Error('stream failed')
            return generator()
          }
        }
      }
      static get instanceCount() {
        return constructed
      }
    }
  })
}

describe('chunkText — 1.0.4-AD thinking-bleed filter', () => {
  // Regression: Gemini's thinking-capable models stream
  // `parts[].thought === true` parts alongside visible response
  // parts in the SAME candidates[0].content.parts array. Pre-fix,
  // `chunkText` concatenated every text part regardless of the
  // flag — so the model's reasoning monologue leaked into the
  // assistant bubble. Reported by the maintainer from an ensemble transcript:
  // "Acknowledging the User's Sign-off, I am recognizing…
  // [Thought: true]Crafting the Sign-off Response…".

  it('drops parts where thought === true', () => {
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Acknowledging the sign-off…', thought: true }, { text: 'Good luck!' }]
          }
        }
      ]
    }
    expect(chunkTextForTest(chunk)).toBe('Good luck!')
  })

  it('preserves parts where thought is false or absent', () => {
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello ' }, { text: 'world!', thought: false }]
          }
        }
      ]
    }
    expect(chunkTextForTest(chunk)).toBe('Hello world!')
  })

  it('strips literal `[Thought: true]` / `[Thought: false]` markers as defense-in-depth', () => {
    // In case Gemini ever returns thought-flagged content INSIDE
    // an unflagged part (or via the `chunk.text` fast-path),
    // strip the residual markers so the visible bubble stays
    // clean even when the per-part flag fails us.
    const chunk = {
      candidates: [
        {
          content: {
            parts: [
              { text: '[Thought: true]reasoning chunk ' },
              { text: '[Thought: false]visible reply.' }
            ]
          }
        }
      ]
    }
    expect(chunkTextForTest(chunk)).toBe('reasoning chunk visible reply.')
  })

  it('handles the chunk.text fallback path with the marker stripper', () => {
    const chunk = { text: '[Thought: true]Visible reply.' }
    expect(chunkTextForTest(chunk)).toBe('Visible reply.')
  })

  it('returns empty string for nullish chunks', () => {
    expect(chunkTextForTest(null)).toBe('')
    expect(chunkTextForTest(undefined)).toBe('')
    expect(chunkTextForTest({})).toBe('')
  })

  it('extracts only thought parts for the reasoning channel', () => {
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ text: 'internal monologue ', thought: true }, { text: 'visible reply.' }]
          }
        }
      ]
    }
    expect(chunkThoughtTextForTest(chunk)).toBe('internal monologue ')
    expect(chunkThoughtTextForTest(null)).toBe('')
    expect(chunkThoughtTextForTest({})).toBe('')
  })

  it('returns empty when every part is a thought', () => {
    // The whole turn was reasoning — no visible response. We
    // want the visible stream to stay empty so the assistant
    // bubble doesn't render "[Thought: true]…" artifacts; the
    // result/finalisation event still drives turn-end.
    const chunk = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Step 1: think.', thought: true },
              { text: 'Step 2: think more.', thought: true }
            ]
          }
        }
      ]
    }
    expect(chunkTextForTest(chunk)).toBe('')
  })
})

describe('GeminiApiProvider (Phase M1 Step 2)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('AppSettings.geminiApiRuntime defaults to "auto" on fresh install', () => {
    const settings = AppStore.getSettings()
    expect(settings.geminiApiRuntime).toBe('auto')
  })

  it('returns false when geminiApiRuntime is "never"', async () => {
    const { deps, lines, exits } = makeDeps({
      settings: { geminiApiRuntime: 'never' },
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'should not be reached' }])
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(false)
    expect(lines).toEqual([])
    expect(exits).toEqual([])
  })

  it('returns false when no auth profile is selected in auto mode', async () => {
    const { deps, lines, exits } = makeDeps({
      profiles: [],
      defaultProfileId: null,
      loadSdk: fakeSdk([{ text: 'unused' }])
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(false)
    expect(lines).toEqual([])
    expect(exits).toEqual([])
  })

  it('returns false for non-api-key profile kinds (Step 2 only handles api-key)', async () => {
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile({ kind: 'vertex-ai' })],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'unused' }])
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(false)
  })

  it('returns false when SDK load fails', async () => {
    const { deps, lines, errors } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: async () => null
    })
    const attachAbortController = vi.fn()
    deps.runManager.attachAbortController = attachAbortController
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(false)
    // No init emitted yet because we bail before constructing the client.
    expect(lines).toEqual([])
    expect(errors).toEqual([])
    expect(attachAbortController).not.toHaveBeenCalled()
  })

  it('uses the shared setup signal during deferred SDK discovery without adopting API ownership', async () => {
    const setupController = new AbortController()
    let finishSdkDiscovery!: (sdk: null) => void
    const sdkDiscovery = new Promise<null>((resolve) => {
      finishSdkDiscovery = resolve
    })
    const { deps, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: () => sdkDiscovery
    })
    const attachAbortController = vi.fn()
    deps.runManager.attachAbortController = attachAbortController

    const run = tryRunGeminiApi(
      stubEvent,
      { ...basePayload, providerSetupAbortSignal: setupController.signal },
      baseRoute,
      deps
    )
    setupController.abort()
    finishSdkDiscovery(null)

    await expect(run).resolves.toBe(true)
    expect(attachAbortController).not.toHaveBeenCalled()
    expect(exits).toEqual([{ provider: 'gemini', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })

  it('rechecks main-owned persistence authority after deferred SDK discovery', async () => {
    let finishSdkDiscovery!: (sdk: any) => void
    const sdkDiscovery = new Promise<any>((resolve) => {
      finishSdkDiscovery = resolve
    })
    let persistenceAuthorized = true
    const beginTransportOperation = vi.fn()
    const { deps, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: () => sdkDiscovery,
      runPersistenceAuthorized: () => persistenceAuthorized,
      beginTransportOperation
    })

    const run = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    persistenceAuthorized = false
    finishSdkDiscovery(await fakeSdk([])())

    await expect(run).resolves.toBe(true)
    expect(beginTransportOperation).not.toHaveBeenCalled()
    expect(exits).toEqual([{ provider: 'gemini', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })

  it('streams text chunks as content events and emits init + result + exit', async () => {
    const usage = {
      promptTokenCount: 4,
      candidatesTokenCount: 7,
      totalTokenCount: 11
    }
    const chunks = [{ text: 'Hello, ' }, { text: 'world!' }, { text: '', usageMetadata: usage }]
    const { deps, lines, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk(chunks)
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)

    const events = lines.map((line) => line.payload)
    const initEvent = events[0]
    expect(initEvent.type).toBe('init')
    expect(initEvent.session_id).toBe('api://chat-1')
    expect(initEvent.runtime).toBe('api-sdk')
    expect(typeof initEvent.model).toBe('string')

    const contents = events.filter((event) => event.type === 'content')
    expect(contents.map((event) => event.text)).toEqual(['Hello, ', 'world!'])
    contents.forEach((event) => expect(event.provider).toBe('gemini'))

    const result = events.find((event) => event.type === 'result')
    expect(result).toBeDefined()
    expect(result.status).toBe('success')
    expect(result.stats.promptTokenCount).toBe(4)
    expect(result.stats.candidatesTokenCount).toBe(7)
    expect(result.stats.totalTokenCount).toBe(11)
    expect(typeof result.stats.duration_ms).toBe('number')
    expect(result.providerThreadId).toBe('api://chat-1')

    expect(errors).toEqual([])
    expect(exits).toEqual([{ provider: 'gemini', code: 0 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
  })

  it('settles API ownership even when the terminal result projector throws', async () => {
    let settleTransport!: () => void
    const transportSettlement = new Promise<void>((resolve) => {
      settleTransport = resolve
    })
    const markTransportClosed = vi.fn(() => settleTransport())
    const { deps, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'done' }]),
      beginTransportOperation: () => ({
        settlement: transportSettlement,
        markTransportClosed
      })
    })
    const sendLine = deps.sendAgentCompatLine
    deps.sendAgentCompatLine = (sender, provider, payload, route) => {
      if (payload?.type === 'result') throw new Error('terminal projector failed')
      sendLine(sender, provider, payload, route)
    }

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).rejects.toThrow(
      'terminal projector failed'
    )
    expect(exits).toEqual([{ provider: 'gemini', code: 0 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    expect(markTransportClosed).toHaveBeenCalledOnce()
  })

  it('terminalizes adopted API ownership when init projection throws', async () => {
    let settleTransport!: () => void
    const transportSettlement = new Promise<void>((resolve) => {
      settleTransport = resolve
    })
    const markTransportClosed = vi.fn(() => settleTransport())
    const { deps, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'unused' }]),
      beginTransportOperation: () => ({
        settlement: transportSettlement,
        markTransportClosed
      })
    })
    const sendLine = deps.sendAgentCompatLine
    deps.sendAgentCompatLine = (sender, provider, payload, route) => {
      if (payload?.type === 'init') throw new Error('init projector detached')
      sendLine(sender, provider, payload, route)
    }

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toEqual([
      {
        provider: 'gemini',
        error: 'Gemini API lifecycle failed after transport adoption: init projector detached'
      }
    ])
    expect(exits).toEqual([{ provider: 'gemini', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
    expect(markTransportClosed).toHaveBeenCalledOnce()
  })

  it('extracts text from candidates.parts when chunk.text is empty', async () => {
    const chunks = [{ candidates: [{ content: { parts: [{ text: 'from-parts' }] } }] }]
    const { deps, lines } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk(chunks)
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toEqual(['from-parts'])
  })

  it('surfaces an error and finishes "failed" when stream throws', async () => {
    const { deps, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([], { throwOn: 'stream' })
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Gemini API stream failed/i)
    expect(exits).toEqual([{ provider: 'gemini', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
  })

  it('surfaces an error and finishes "failed" when client construction throws', async () => {
    const { deps, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([], { throwOn: 'init' })
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Failed to initialise Gemini API client/i)
    expect(exits).toEqual([{ provider: 'gemini', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
  })

  it('emits a useful error when the api key fails to decrypt', async () => {
    const { deps, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      decrypt: () => null,
      loadSdk: fakeSdk([{ text: 'unused' }])
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/no usable API key/i)
    expect(exits).toEqual([{ provider: 'gemini', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
  })

  it('honours an in-flight abort by exiting 130 and finishing "cancelled"', async () => {
    // Capture the controller wired through runManager so the test can
    // abort it mid-stream. Yields one chunk, then waits a microtask so
    // the for-await loop checks signal.aborted before pulling the next.
    const controllerHolder: { current: AbortController | null } = { current: null }
    // Gate the generator on a deferred promise: the test resolves it
    // AFTER calling abort(), so the for-await loop pulls the second
    // chunk only once the signal is already aborted (matching how a
    // real SDK suspends between server responses).
    // Initial no-op satisfies TS strict-null-check; the Promise constructor
    // runs synchronously so the real `resolve` is in place before we ever
    // call this through.
    let releaseSecond: () => void = () => {}
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const generator = async function* () {
      yield { text: 'partial' }
      await secondReady
      yield { text: 'should-not-stream' }
    }
    const sdk = async () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => generator()
        }
      }
    })
    const { deps, exits, finishes, lines } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: sdk
    })
    deps.runManager.attachAbortController = (_runId, c) => {
      controllerHolder.current = c as AbortController
      return undefined
    }
    const promise = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    // Let the first chunk stream through, then abort + release the
    // gate so the loop wakes up, observes signal.aborted, and bails.
    await new Promise((resolve) => setImmediate(resolve))
    controllerHolder.current?.abort()
    releaseSecond()
    await expect(promise).resolves.toBe(true)
    expect(exits).toEqual([{ provider: 'gemini', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
    // Ensure the "should-not-stream" chunk never reached the renderer.
    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).not.toContain('should-not-stream')
  })
})

/**
 * Phase M1 Step 3 — function calling against the TaskWraith MCP tool
 * surface. These tests mock the SDK + executor; they don't reach the
 * real `executeGeminiMcpTool` (covered separately by integration tests
 * in `index.ts`). The point is to pin the LOOP: model emits function
 * call → dispatch via deps.executeMcpTool → feed response back → repeat.
 */
function makeMcpTool(name: string) {
  return {
    name,
    description: `Stub tool ${name}.`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
  }
}

/** SDK fake that scripts a sequence of chunk-arrays (one inner array
 *  per `generateContentStream` call). Lets us simulate the
 *  multi-round dance: round 0 emits a functionCall, round 1 emits text.
 *  Also captures the `contents` passed on each call so tests can
 *  assert the functionResponse parts make it into the next turn. */
function scriptedSdk(rounds: any[][]): {
  loader: () => Promise<any | null>
  callsRef: Array<{ model: string; contents: any[]; config: any }>
} {
  const callsRef: Array<{ model: string; contents: any[]; config: any }> = []
  let roundIndex = 0
  const loader = async () => ({
    GoogleGenAI: class {
      models = {
        generateContentStream: async (params: any) => {
          // Deep-ish copy contents so the test can assert the snapshot
          // at call-time without later mutations clobbering it.
          callsRef.push({
            model: params.model,
            contents: JSON.parse(JSON.stringify(params.contents)),
            config: params.config
          })
          const chunks = rounds[roundIndex] || []
          roundIndex++
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        }
      }
    }
  })
  return { loader, callsRef }
}

describe('GeminiApiProvider (Phase M1 Step 3 — function calling)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('advertises only the compact Ensemble control shape to fresh API sessions', () => {
    const tools = [makeMcpTool('ensemble_bossman_control'), makeMcpTool('ensemble_control')]
    expect(
      filterGeminiApiMcpToolsForProfile(tools, 'taskwraith-gateway-v6').map((tool) => tool.name)
    ).toEqual(['ensemble_control'])
    expect(
      filterGeminiApiMcpToolsForProfile(tools, 'taskwraith-gateway-v5').map((tool) => tool.name)
    ).toEqual(['ensemble_bossman_control'])
  })

  it('never widens native API declarations with the gateway-v9 hidden retry tool', () => {
    const tools = [makeMcpTool('read_file'), makeMcpTool('request_tool_permission')]
    expect(
      filterGeminiApiMcpToolsForProfile(tools, 'taskwraith-gateway-v8').map((tool) => tool.name)
    ).toEqual(['read_file'])
    expect(
      filterGeminiApiMcpToolsForProfile(tools, 'taskwraith-gateway-v9').map((tool) => tool.name)
    ).toEqual(['read_file'])
  })

  it('gives a receipted gateway API seat the virtual gateway without declaring retry directly', () => {
    const tools = [
      makeMcpTool('read_file'),
      makeMcpTool('request_tool_permission'),
      ...gatewayToolDefinitions()
    ]
    expect(
      filterGeminiApiMcpToolsForProfile(tools, 'taskwraith-gateway-v9').map((tool) => tool.name)
    ).toEqual(['read_file', 'capability_search', 'capability_invoke'])
  })

  it('passes function declarations on every generateContentStream call', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'final answer' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file'), makeMcpTool('write_file')]
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(callsRef).toHaveLength(1)
    const tools = callsRef[0].config?.tools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools[0].functionDeclarations).toHaveLength(2)
    expect(tools[0].functionDeclarations.map((d: any) => d.name)).toEqual([
      'read_file',
      'write_file'
    ])
  })

  it('omits config.tools entirely when no MCP tools are configured', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'plain answer' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: []
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    // Function calling is disabled, while the request-owned abort signal still
    // reaches the SDK's supported GenerateContentConfig surface.
    expect(callsRef[0].config?.tools).toBeUndefined()
    expect(callsRef[0].config?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('dispatches a function call, feeds the response back, and emits final text', async () => {
    const { loader, callsRef } = scriptedSdk([
      // Round 0: model asks to read a file.
      [
        {
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }]
        }
      ],
      // Round 1: model emits final text after seeing the result.
      [{ text: 'Got it.' }]
    ])
    const { deps, toolCalls, lines } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'file contents here', isError: false })
    })
    const ok = await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(ok).toBe(true)
    // Executor called exactly once with the expected name + args.
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].toolName).toBe('read_file')
    expect(toolCalls[0].args).toEqual({ path: 'README.md' })
    // Two stream calls: round 0 and round 1.
    expect(callsRef).toHaveLength(2)
    // Round 1's contents should include the model's function-call turn
    // + the user-side function-response turn.
    const round1Contents = callsRef[1].contents
    expect(round1Contents).toHaveLength(3) // initial user + model + user response
    expect(round1Contents[1].role).toBe('model')
    expect(round1Contents[1].parts[0].functionCall.name).toBe('read_file')
    expect(round1Contents[2].role).toBe('user')
    expect(round1Contents[2].parts[0].functionResponse.name).toBe('read_file')
    expect(round1Contents[2].parts[0].functionResponse.response).toEqual({
      output: 'file contents here'
    })
    // Final content event contains the model's text.
    const texts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(texts).toEqual(['Got it.'])
  })

  it('does not reuse an earlier tool-round usage snapshot when the final invocation omits it', async () => {
    const { loader } = scriptedSdk([
      [
        {
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 1,
            totalTokenCount: 13
          }
        }
      ],
      [{ text: 'Final answer without usage metadata.' }]
    ])
    const { deps, lines, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'file contents here', isError: false })
    })

    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)

    const result = lines.find((line) => line.payload?.type === 'result')?.payload
    expect(result?.stats).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    })
    expect(result?.stats?._taskwraith_context_usage).toBeUndefined()
    expect(usageRecords[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    })
  })

  // Live 400 on 2026-07-25 with gemini-3.5-flash:
  //   "Function call is missing a thought_signature in functionCall parts...
  //    function call `default_api:find_files`, position 2"
  // 3.x thinking models attach an opaque signature to the function-call PART
  // and require it echoed back verbatim; the replayed model turn was rebuilt
  // from name+args only, so every 3.x tool loop died on the SECOND request.
  it('echoes a thought signature back on the replayed model turn', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          // Real SDK chunks carry BOTH: the flattened convenience getter and
          // the raw parts. Only the parts hold the signature.
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }],
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
                    thoughtSignature: 'sig-abc123'
                  }
                ]
              }
            }
          ]
        }
      ],
      [{ text: 'Got it.' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'file contents here', isError: false })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)

    const modelPart = callsRef[1].contents[1].parts[0]
    expect(modelPart.functionCall.name).toBe('read_file')
    // Sibling of functionCall, not a field inside it.
    expect(modelPart.thoughtSignature).toBe('sig-abc123')
    expect(modelPart.functionCall.thoughtSignature).toBeUndefined()
  })

  it('recovers the signature when only the raw parts are present', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'read_file', args: { path: 'a.txt' } },
                    thoughtSignature: 'sig-parts-only'
                  }
                ]
              }
            }
          ]
        }
      ],
      [{ text: 'done' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'ok', isError: false })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(callsRef[1].contents[1].parts[0].thoughtSignature).toBe('sig-parts-only')
  })

  it('zips signatures positionally across multiple calls in one chunk', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          functionCalls: [
            { name: 'read_file', args: { path: 'a.txt' } },
            { name: 'read_file', args: { path: 'b.txt' } }
          ],
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'read_file', args: { path: 'a.txt' } },
                    thoughtSignature: 'sig-a'
                  },
                  {
                    functionCall: { name: 'read_file', args: { path: 'b.txt' } },
                    thoughtSignature: 'sig-b'
                  }
                ]
              }
            }
          ]
        }
      ],
      [{ text: 'done' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'ok', isError: false })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const parts = callsRef[1].contents[1].parts
    expect(parts.map((p: { thoughtSignature?: string }) => p.thoughtSignature)).toEqual([
      'sig-a',
      'sig-b'
    ])
  })

  it('omits the key entirely for 2.5-era models that emit no signature', async () => {
    // Sending `thoughtSignature: undefined` would serialise as an explicit null
    // on some transports; the key must simply be absent.
    const { loader, callsRef } = scriptedSdk([
      [{ functionCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }],
      [{ text: 'done' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'ok', isError: false })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect('thoughtSignature' in callsRef[1].contents[1].parts[0]).toBe(false)
  })

  it('prepares the host tool context before dispatching API function calls', async () => {
    const order: string[] = []
    const { loader } = scriptedSdk([
      [{ functionCalls: [{ name: 'read_file', args: { path: 'README.md' } }] }],
      [{ text: 'done' }]
    ])
    const { deps, toolContextPreparations, toolCalls } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      prepareToolContext: () => {
        order.push('prepare')
      },
      executeMcpTool: async () => {
        order.push('tool')
        return { text: 'file contents', isError: false }
      }
    })

    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)

    expect(order).toEqual(['prepare', 'tool'])
    expect(toolContextPreparations).toHaveLength(1)
    expect(toolContextPreparations[0]).toMatchObject({
      route: baseRoute,
      sessionId: 'api://chat-1'
    })
    expect(toolCalls).toHaveLength(1)
  })

  it('handles multi-round tool use (two distinct tools, each fed back)', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }]
        }
      ],
      [
        {
          functionCalls: [
            {
              id: 'call-2',
              name: 'run_shell_command',
              args: { command: 'wc -l a.txt' }
            }
          ]
        }
      ],
      [{ text: 'Both done.' }]
    ])
    const seenTools: string[] = []
    const { deps, toolCalls } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file'), makeMcpTool('run_shell_command')],
      executeMcpTool: async (name) => {
        seenTools.push(name)
        return { text: `result-of-${name}`, isError: false }
      }
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(seenTools).toEqual(['read_file', 'run_shell_command'])
    expect(toolCalls.map((c) => c.toolName)).toEqual(['read_file', 'run_shell_command'])
    expect(callsRef).toHaveLength(3)
  })

  it('exits with an error after MAX_TOOL_ROUNDS without final text', async () => {
    // Always emit a function call → model never produces final text →
    // loop should cap out and emit an error event.
    const rounds: any[][] = []
    for (let i = 0; i < 25; i++) {
      rounds.push([
        {
          functionCalls: [{ id: `call-${i}`, name: 'read_file', args: { path: 'x' } }]
        }
      ])
    }
    const { loader } = scriptedSdk(rounds)
    const { deps, errors, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'ok', isError: false })
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/exceeded 20 tool-use rounds/)
    expect(exits).toEqual([{ provider: 'gemini', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
  })

  it('propagates an error-flagged tool result back as an `error` response part', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          functionCalls: [{ id: 'call-1', name: 'write_file', args: { path: 'x' } }]
        }
      ],
      [{ text: 'Recovered.' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('write_file')],
      executeMcpTool: async () => ({ text: 'denied by TaskWraith', isError: true })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const round1Contents = callsRef[1].contents
    expect(round1Contents[2].parts[0].functionResponse.response).toEqual({
      error: 'denied by TaskWraith'
    })
  })

  it('extracts function calls from candidates.parts when chunk.functionCalls is absent', async () => {
    const { loader } = scriptedSdk([
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: 'fallback.txt' }
                    }
                  }
                ]
              }
            }
          ]
        }
      ],
      [{ text: 'Read via fallback.' }]
    ])
    const { deps, toolCalls } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => ({ text: 'contents', isError: false })
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].args).toEqual({ path: 'fallback.txt' })
  })

  it('exits with 130 when the user aborts during tool execution', async () => {
    const controllerHolder: { current: AbortController | null } = { current: null }
    // Deferred promise gates the executor: the test resolves it AFTER
    // calling abort(), so the await in the tool loop unblocks into an
    // already-aborted controller and exits cleanly.
    let releaseExecutor: () => void = () => {}
    const executorPending = new Promise<void>((resolve) => {
      releaseExecutor = resolve
    })
    const { loader } = scriptedSdk([
      [
        {
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'x' } }]
        }
      ],
      [{ text: 'should-not-reach' }]
    ])
    const { deps, exits, finishes, lines } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => {
        await executorPending
        return { text: 'late', isError: false }
      }
    })
    deps.runManager.attachAbortController = (_runId, c) => {
      controllerHolder.current = c as AbortController
      return undefined
    }
    const promise = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    // Yield until the executor is awaiting on `executorPending`.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    controllerHolder.current?.abort()
    releaseExecutor()
    await expect(promise).resolves.toBe(true)
    expect(exits).toEqual([{ provider: 'gemini', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
    // The second round's text MUST NOT have made it through.
    const texts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(texts).not.toContain('should-not-reach')
  })

  it("converts a thrown executor into an error response (doesn't crash the loop)", async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          functionCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'boom' } }]
        }
      ],
      [{ text: 'Caught it.' }]
    ])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      mcpTools: [makeMcpTool('read_file')],
      executeMcpTool: async () => {
        throw new Error('something blew up')
      }
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    const round1Contents = callsRef[1].contents
    expect(round1Contents[2].parts[0].functionResponse.response.error).toMatch(/something blew up/)
  })
})

/**
 * Phase M1 Step 5 — multi-turn history replay + linkedProviderSessionId
 * persistence. Verifies the conversion path end-to-end inside the provider
 * (separate from the unit-tested converter in GeminiApiHistoryAdapter.test.ts):
 *   - chat history flows through to `generateContentStream({ contents })`
 *   - the synthetic `api://<appChatId>` id is pinned on the chat record
 *     after success, with the field-level merge rules from the dep doc
 */
function makeChat(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Test chat',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeChatMessage(
  role: ChatMessage['role'],
  content: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: overrides.id ?? `msg-${role}-${content.slice(0, 6)}`,
    role,
    content,
    timestamp: overrides.timestamp ?? new Date(0).toISOString(),
    ...overrides
  }
}

describe('GeminiApiProvider (Phase M1 Step 5 — history replay & session pinning)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('replays prior user + assistant messages into contents alongside the current prompt', () => {
    return (async () => {
      const chat = makeChat({
        messages: [
          makeChatMessage('user', "what's 2+2?"),
          makeChatMessage('assistant', '4'),
          // Renderer typically persists the just-typed user message BEFORE
          // dispatching the provider call. The adapter should merge it
          // with the current prompt (or drop a true duplicate) so the
          // strict alternation invariant holds.
          makeChatMessage('user', 'double that')
        ]
      })
      const { loader, callsRef } = scriptedSdk([[{ text: '8' }]])
      const { deps } = makeDeps({
        profiles: [makeApiKeyProfile()],
        defaultProfileId: 'profile-1',
        loadSdk: loader,
        getChat: () => chat
      })
      await tryRunGeminiApi(stubEvent, { ...basePayload, prompt: 'double that' }, baseRoute, deps)
      expect(callsRef).toHaveLength(1)
      const contents = callsRef[0].contents
      // 3 entries: user "what's 2+2?" → model "4" → user "double that"
      expect(contents).toHaveLength(3)
      expect(contents[0].role).toBe('user')
      expect(contents[0].parts[0].text).toBe("what's 2+2?")
      expect(contents[1].role).toBe('model')
      expect(contents[1].parts[0].text).toBe('4')
      expect(contents[2].role).toBe('user')
      expect(contents[2].parts[0].text).toBe('double that')
    })()
  })

  it('falls back to a single-turn request when the chat has no history', async () => {
    const chat = makeChat({ messages: [] })
    const { loader, callsRef } = scriptedSdk([[{ text: 'hi back' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const contents = callsRef[0].contents
    expect(contents).toHaveLength(1)
    expect(contents[0].role).toBe('user')
    expect(contents[0].parts[0].text).toBe('Hello Gemini')
  })

  it('never replays chat history for ensemble seat turns (composed prompt owns context)', async () => {
    const chat = makeChat({
      messages: [makeChatMessage('user', "what's 2+2?"), makeChatMessage('assistant', '4')]
    })
    const { loader, callsRef } = scriptedSdk([[{ text: 'seat answer' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      getChat: () => chat
    })
    await tryRunGeminiApi(
      stubEvent,
      {
        ...basePayload,
        prompt: 'TAGGED_TRANSCRIPT_PROMPT with seat instructions',
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'seat-1',
          provider: 'antigravity',
          role: 'Builder',
          order: 1
        }
      },
      baseRoute,
      deps
    )
    const contents = callsRef[0].contents
    // The orchestrator-composed prompt already embeds the tagged shared
    // transcript — replaying chat.messages here would double-inject the
    // whole conversation. Ensemble seats run single-turn.
    expect(contents).toHaveLength(1)
    expect(contents[0].role).toBe('user')
    expect(contents[0].parts[0].text).toBe('TAGGED_TRANSCRIPT_PROMPT with seat instructions')
    const flat = JSON.stringify(contents)
    expect(flat).not.toMatch(/2\+2/)
  })

  it('falls back to a single-turn request when getChat is not provided (back-compat)', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'ok' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader
      // no getChat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const contents = callsRef[0].contents
    expect(contents).toHaveLength(1)
    expect(contents[0].role).toBe('user')
    expect(contents[0].parts[0].text).toBe('Hello Gemini')
  })

  it('skips system, tool, and error messages from the replayed history', async () => {
    const chat = makeChat({
      messages: [
        makeChatMessage('user', 'q1'),
        makeChatMessage('system', '↩ Result from sub-thread'),
        makeChatMessage('tool', 'tool body that should not leak'),
        makeChatMessage('error', 'EACCES'),
        makeChatMessage('assistant', 'a1')
      ]
    })
    const { loader, callsRef } = scriptedSdk([[{ text: 'final' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const contents = callsRef[0].contents
    // q1 → a1 → current prompt
    expect(contents).toHaveLength(3)
    expect(contents[0].parts[0].text).toBe('q1')
    expect(contents[1].parts[0].text).toBe('a1')
    expect(contents[2].parts[0].text).toBe('Hello Gemini')
    // The synthetic system text and the tool/error bodies should never
    // make it into any content part.
    const flat = contents.flatMap((c: any) => c.parts.map((p: any) => p.text || '')).join('|')
    expect(flat).not.toMatch(/Result from sub-thread/)
    expect(flat).not.toMatch(/tool body that should not leak/)
    expect(flat).not.toMatch(/EACCES/)
  })

  it('persists linkedProviderSessionId = "api://<appChatId>" after successful run', async () => {
    const chat = makeChat({ messages: [], linkedProviderSessionId: undefined })
    const saves: Array<{ chatId: string; sessionId: string }> = []
    const { deps, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat,
      saveChatLinkedSessionId: (chatId, sessionId) => {
        saves.push({ chatId, sessionId })
      }
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    expect(saves).toEqual([{ chatId: 'chat-1', sessionId: 'api://chat-1' }])
  })

  it('does NOT persist linkedProviderSessionId on an aborted run', async () => {
    const controllerHolder: { current: AbortController | null } = { current: null }
    let releaseSecond: () => void = () => {}
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const generator = async function* () {
      yield { text: 'partial' }
      await secondReady
      yield { text: 'should-not-stream' }
    }
    const sdk = async () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => generator()
        }
      }
    })
    const saves: Array<{ chatId: string; sessionId: string }> = []
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: sdk,
      saveChatLinkedSessionId: (chatId, sessionId) => {
        saves.push({ chatId, sessionId })
      }
    })
    deps.runManager.attachAbortController = (_runId, c) => {
      controllerHolder.current = c as AbortController
      return undefined
    }
    const promise = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    await new Promise((resolve) => setImmediate(resolve))
    controllerHolder.current?.abort()
    releaseSecond()
    await promise
    expect(saves).toEqual([])
  })

  it('does NOT persist linkedProviderSessionId on a failed-stream run', async () => {
    const saves: Array<{ chatId: string; sessionId: string }> = []
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([], { throwOn: 'stream' }),
      saveChatLinkedSessionId: (chatId, sessionId) => {
        saves.push({ chatId, sessionId })
      }
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(saves).toEqual([])
  })

  // Dep-factory-level rules — the persistence helper supplied by
  // `geminiApiProviderDeps()` enforces the field-level merge rules. The
  // tests below exercise those rules directly (no real provider call
  // needed). They cover the spec:
  //   - api://... existing: leave alone
  //   - cli://... existing: overwrite (legacy)
  //   - missing: set
  describe('saveChatLinkedSessionId merge rules', () => {
    function makeSaver(initial: ChatRecord): {
      save: (chatId: string, sessionId: string) => void
      record: ChatRecord
    } {
      // Mirror the production dep factory closely without touching
      // AppStore (which would require a temp dir + write IO). The
      // semantics are what matter to this test.
      const record = { ...initial }
      const save = (_chatId: string, sessionId: string) => {
        const current = record.linkedProviderSessionId || ''
        if (current.startsWith('api://')) return
        record.linkedProviderSessionId = sessionId
      }
      return { save, record }
    }

    it('sets when previously unset', () => {
      const { save, record } = makeSaver(makeChat({ linkedProviderSessionId: undefined }))
      save('chat-1', 'api://chat-1')
      expect(record.linkedProviderSessionId).toBe('api://chat-1')
    })

    it('overwrites a legacy cli://... id', () => {
      const { save, record } = makeSaver(
        makeChat({ linkedProviderSessionId: 'cli://12345678-1234-1234-1234-123456789abc' })
      )
      save('chat-1', 'api://chat-1')
      expect(record.linkedProviderSessionId).toBe('api://chat-1')
    })

    it('leaves an existing api://... id alone (idempotent across turns)', () => {
      const { save, record } = makeSaver(makeChat({ linkedProviderSessionId: 'api://chat-1' }))
      save('chat-1', 'api://chat-1-fresh')
      expect(record.linkedProviderSessionId).toBe('api://chat-1')
    })
  })

  it('saveChatLinkedSessionId failure does not crash the run', async () => {
    const chat = makeChat({ messages: [] })
    const { deps, finishes, errors } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat,
      saveChatLinkedSessionId: () => {
        throw new Error('disk full')
      }
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    // Run still completes successfully despite the save failure.
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    // We swallow the save error rather than emit it, so the errors
    // array should be empty.
    expect(errors).toEqual([])
  })

  it('multi-turn: round 2 sees round 1 user + assistant in the replayed history', async () => {
    // Turn 1: user "what's 2+2?" → assistant "4"
    // The renderer persists both messages then triggers Turn 2 with
    // prompt "double that". The provider should send Turn 2 with all
    // three entries in `contents`.
    const turn1Chat = makeChat({
      messages: [makeChatMessage('user', "what's 2+2?"), makeChatMessage('assistant', '4')]
    })
    const { loader, callsRef } = scriptedSdk([[{ text: '8' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      getChat: () => turn1Chat
    })
    await tryRunGeminiApi(stubEvent, { ...basePayload, prompt: 'double that' }, baseRoute, deps)
    const contents = callsRef[0].contents
    expect(contents).toHaveLength(3)
    // Roles strictly alternate user/model/user.
    expect(contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user'])
    // Turn 1's user + assistant texts are visible to the model.
    expect(contents[0].parts[0].text).toBe("what's 2+2?")
    expect(contents[1].parts[0].text).toBe('4')
    // Turn 2's prompt is the current user turn.
    expect(contents[2].parts[0].text).toBe('double that')
  })
})

/**
 * Phase M1 Step 7 — image input. We mock `readImageFile` so tests stay
 * IO-free and can simulate arbitrary file sizes (and the oversize
 * upload path) without touching the disk. The provider mounts image
 * parts BEFORE the text part in the current user turn.
 */
describe('GeminiApiProvider (Phase M1 Step 7 — image input)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('attaches a single image as inlineData before the text part', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'ack' }]])
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      readImageFile: async (path) => (path === '/tmp/screenshot.png' ? fakeBytes : null)
    })
    await tryRunGeminiApi(
      stubEvent,
      { ...basePayload, imagePaths: ['/tmp/screenshot.png'] },
      baseRoute,
      deps
    )
    expect(callsRef).toHaveLength(1)
    const lastTurn = callsRef[0].contents[callsRef[0].contents.length - 1]
    expect(lastTurn.role).toBe('user')
    // image part comes first, text part second
    expect(lastTurn.parts).toHaveLength(2)
    expect(lastTurn.parts[0].inlineData.mimeType).toBe('image/png')
    expect(lastTurn.parts[0].inlineData.data).toBe(fakeBytes.toString('base64'))
    expect(lastTurn.parts[1].text).toBe('Hello Gemini')
  })

  it('attaches two images in order before the text part', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'got both' }]])
    const png = Buffer.from('first-png-bytes')
    const jpg = Buffer.from('second-jpg-bytes')
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      readImageFile: async (path) => {
        if (path === '/tmp/a.png') return png
        if (path === '/tmp/b.jpg') return jpg
        return null
      }
    })
    await tryRunGeminiApi(
      stubEvent,
      { ...basePayload, imagePaths: ['/tmp/a.png', '/tmp/b.jpg'] },
      baseRoute,
      deps
    )
    const lastTurn = callsRef[0].contents[callsRef[0].contents.length - 1]
    expect(lastTurn.parts).toHaveLength(3)
    expect(lastTurn.parts[0].inlineData.mimeType).toBe('image/png')
    expect(lastTurn.parts[1].inlineData.mimeType).toBe('image/jpeg')
    expect(lastTurn.parts[2].text).toBe('Hello Gemini')
  })

  it('logs a warning and skips images with unsupported extensions (run still completes)', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'partial' }]])
    const png = Buffer.from('valid-png')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { deps, exits, finishes } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      readImageFile: async (path) => (path === '/tmp/ok.png' ? png : Buffer.from('unused'))
    })
    await tryRunGeminiApi(
      stubEvent,
      {
        ...basePayload,
        imagePaths: ['/tmp/ok.png', '/tmp/mystery.xyz', '/tmp/notes.txt']
      },
      baseRoute,
      deps
    )
    const lastTurn = callsRef[0].contents[callsRef[0].contents.length - 1]
    // Only the .png makes it through; the unsupported ones are dropped.
    expect(lastTurn.parts).toHaveLength(2)
    expect(lastTurn.parts[0].inlineData.mimeType).toBe('image/png')
    expect(lastTurn.parts[1].text).toBe('Hello Gemini')
    expect(warnSpy).toHaveBeenCalled()
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(warnings.some((m) => m.includes('/tmp/mystery.xyz'))).toBe(true)
    expect(warnings.some((m) => m.includes('/tmp/notes.txt'))).toBe(true)
    // Run still completes successfully.
    expect(exits).toEqual([{ provider: 'gemini', code: 0 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    warnSpy.mockRestore()
  })

  it('emits no inlineData parts when payload.imagePaths is empty/absent', async () => {
    const { loader, callsRef } = scriptedSdk([[{ text: 'no-image' }]])
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      readImageFile: async () => {
        throw new Error('reader should not be called when imagePaths is empty')
      }
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    const lastTurn = callsRef[0].contents[callsRef[0].contents.length - 1]
    expect(lastTurn.parts).toHaveLength(1)
    expect(lastTurn.parts[0].text).toBe('Hello Gemini')
    expect(lastTurn.parts.every((p: any) => !('inlineData' in p) && !('fileData' in p))).toBe(true)
  })

  it('uses files.upload for oversized images and emits a fileData part', async () => {
    // 21MB synthetic buffer — over the 20MB inline cutoff.
    const oversized = Buffer.alloc(21 * 1024 * 1024, 0xab)
    // Build a custom SDK that also records files.upload calls so we can
    // assert the mime-type passed through.
    const uploadCalls: Array<{ file: string; mimeType: string; abortSignal: AbortSignal }> = []
    const streamCalls: Array<{ contents: any[]; abortSignal: AbortSignal }> = []
    const loader = async () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async (params: any) => {
            streamCalls.push({
              contents: JSON.parse(JSON.stringify(params.contents)),
              abortSignal: params.config?.abortSignal
            })
            return (async function* () {
              yield { text: 'uploaded' }
            })()
          }
        }
        files = {
          upload: async (params: any) => {
            uploadCalls.push({
              file: params.file,
              mimeType: params.config?.mimeType,
              abortSignal: params.config?.abortSignal
            })
            return { uri: `gs://fake-bucket/${params.file.split('/').pop()}` }
          }
        }
      }
    })
    const { deps } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: loader,
      readImageFile: async () => oversized
    })
    await tryRunGeminiApi(
      stubEvent,
      { ...basePayload, imagePaths: ['/tmp/huge.png'] },
      baseRoute,
      deps
    )
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0]).toMatchObject({
      file: '/tmp/huge.png',
      mimeType: 'image/png'
    })
    expect(uploadCalls[0].abortSignal).toBeInstanceOf(AbortSignal)
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0].abortSignal).toBe(uploadCalls[0].abortSignal)
    const lastTurn = streamCalls[0].contents[streamCalls[0].contents.length - 1]
    expect(lastTurn.parts).toHaveLength(2)
    expect(lastTurn.parts[0].fileData).toEqual({
      fileUri: 'gs://fake-bucket/huge.png',
      mimeType: 'image/png'
    })
    expect(lastTurn.parts[1].text).toBe('Hello Gemini')
  })
})

/**
 * Phase M1 Step 8 — usage tracking persistence. The provider calls
 * `deps.recordUsage` after a successful run, mapping the API's
 * `usageMetadata` keys (`promptTokenCount`/etc.) onto the host's
 * `UsageRecord` shape (`inputTokens`/etc.).
 */
describe('GeminiApiProvider (Phase M1 Step 8 — usage tracking)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('calls recordUsage with mapped fields on a successful run', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    const usage = {
      promptTokenCount: 17,
      candidatesTokenCount: 23,
      totalTokenCount: 40
    }
    const chunks = [{ text: 'hi' }, { text: '', usageMetadata: usage }]
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk(chunks),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(usageRecords).toHaveLength(1)
    const entry = usageRecords[0]
    expect(entry.provider).toBe('gemini')
    expect(entry.workspaceId).toBe('ws-1')
    expect(entry.chatId).toBe('chat-1')
    expect(entry.runId).toBe('run-1')
    expect(entry.usageKind).toBe('run')
    expect(entry.inputTokens).toBe(17)
    expect(entry.outputTokens).toBe(23)
    expect(entry.totalTokens).toBe(40)
    expect(typeof entry.durationMs).toBe('number')
    expect(typeof entry.model).toBe('string')
    expect(entry.model.length).toBeGreaterThan(0)
  })

  it('persists cached prompt tokens separately from non-cache input', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    const usage = {
      promptTokenCount: 17,
      cachedContentTokenCount: 7,
      candidatesTokenCount: 23,
      totalTokenCount: 40
    }
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'hi' }, { text: '', usageMetadata: usage }]),
      getChat: () => chat
    })

    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)

    expect(usageRecords[0]).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 7,
      outputTokens: 23,
      totalTokens: 40
    })
  })

  it('includes thinking tokens when persisted usage must derive its total', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    const usage = {
      promptTokenCount: 17,
      candidatesTokenCount: 23,
      thoughtsTokenCount: 11
    }
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'hi' }, { text: '', usageMetadata: usage }]),
      getChat: () => chat
    })

    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)

    expect(usageRecords[0]).toMatchObject({
      inputTokens: 17,
      outputTokens: 23,
      totalTokens: 51
    })
  })

  it('records zeros (and derives total) when the stream never reports usageMetadata', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    // No usageMetadata in any chunk — older SDK shapes / streaming-only
    // responses can omit it.
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'just text' }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(usageRecords).toHaveLength(1)
    expect(usageRecords[0].inputTokens).toBe(0)
    expect(usageRecords[0].outputTokens).toBe(0)
    expect(usageRecords[0].totalTokens).toBe(0)
  })

  it('uses the global workspace marker for chats with scope=global', async () => {
    const chat = makeChat({ scope: 'global', workspaceId: undefined, messages: [] })
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok', usageMetadata: { totalTokenCount: 5 } }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(usageRecords).toHaveLength(1)
    expect(usageRecords[0].workspaceId).toBe('__taskwraith_global_chats__')
  })

  it('does NOT call recordUsage on a failed-stream run', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([], { throwOn: 'stream' }),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(usageRecords).toEqual([])
  })

  it('does NOT call recordUsage on an aborted run', async () => {
    const controllerHolder: { current: AbortController | null } = { current: null }
    let releaseSecond: () => void = () => {}
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const generator = async function* () {
      yield { text: 'partial' }
      await secondReady
      yield { text: 'should-not-stream', usageMetadata: { totalTokenCount: 99 } }
    }
    const sdk = async () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => generator()
        }
      }
    })
    const { deps, usageRecords } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: sdk
    })
    deps.runManager.attachAbortController = (_runId, c) => {
      controllerHolder.current = c as AbortController
      return undefined
    }
    const promise = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    await new Promise((resolve) => setImmediate(resolve))
    controllerHolder.current?.abort()
    releaseSecond()
    await promise
    expect(usageRecords).toEqual([])
  })

  it('does not crash when recordUsage throws (best-effort tracking)', async () => {
    const chat = makeChat({ workspaceId: 'ws-1', messages: [] })
    const { deps, finishes, errors } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok', usageMetadata: { totalTokenCount: 1 } }]),
      getChat: () => chat,
      recordUsage: () => {
        throw new Error('disk full')
      }
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    // The error must NOT have surfaced via the agent-compat error channel.
    expect(errors).toEqual([])
  })
})

/**
 * Phase M1 Step 9 — migration banner. A chat that previously ran on
 * the Gemini CLI (linkedGeminiSessionId set) emits a single
 * system-role notice the first time it runs through the API path. The
 * gate keys off `linkedProviderSessionId` NOT already starting with
 * `api://` — so a chat that has already migrated never sees the
 * notice again.
 */
describe('GeminiApiProvider (Phase M1 Step 9 — migration banner)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('appends the migration notice when a CLI-linked chat takes its first API turn', async () => {
    const chat = makeChat({
      linkedGeminiSessionId: '12345678-1234-1234-1234-123456789abc',
      linkedProviderSessionId: undefined,
      messages: []
    })
    const { deps, migrationNotices } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(migrationNotices).toHaveLength(1)
    const notice = migrationNotices[0]
    expect(notice.chatId).toBe('chat-1')
    expect(notice.message.role).toBe('system')
    expect(notice.message.id).toBe('gemini-api-migration-run-1')
    expect(notice.message.content).toMatch(/now running via the Gemini API runtime/i)
    expect(notice.message.metadata?.kind).toBe('geminiApiMigrationNotice')
    expect(notice.message.runId).toBe('run-1')
  })

  it('also fires when chat had a legacy cli://... linkedProviderSessionId', async () => {
    // The cli:// id is overwritten by Step 5's saver in the same run,
    // but the GATE looks at the *prior* value (the chat record we read
    // before the run). Step 5's saver writes back after the gate has
    // already fired, so the notice still appears on this first API
    // turn — exactly what we want when a chat transitions runtimes.
    const chat = makeChat({
      linkedGeminiSessionId: '12345678-1234-1234-1234-123456789abc',
      linkedProviderSessionId: 'cli://12345678-1234-1234-1234-123456789abc',
      messages: []
    })
    const { deps, migrationNotices } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(migrationNotices).toHaveLength(1)
  })

  it('does NOT append the notice when the chat already migrated (linkedProviderSessionId starts with api://)', async () => {
    const chat = makeChat({
      linkedGeminiSessionId: '12345678-1234-1234-1234-123456789abc',
      linkedProviderSessionId: 'api://chat-1',
      messages: []
    })
    const { deps, migrationNotices } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(migrationNotices).toEqual([])
  })

  it('does NOT append the notice when the chat has no linkedGeminiSessionId (fresh chat)', async () => {
    const chat = makeChat({
      linkedGeminiSessionId: undefined,
      linkedProviderSessionId: undefined,
      messages: []
    })
    const { deps, migrationNotices } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(migrationNotices).toEqual([])
  })

  it('does NOT append the notice on a failed-stream run', async () => {
    const chat = makeChat({
      linkedGeminiSessionId: '12345678-1234-1234-1234-123456789abc',
      linkedProviderSessionId: undefined,
      messages: []
    })
    const { deps, migrationNotices } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([], { throwOn: 'stream' }),
      getChat: () => chat
    })
    await tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    expect(migrationNotices).toEqual([])
  })

  it('swallows appendChatSystemMessage failures (best-effort notice)', async () => {
    const chat = makeChat({
      linkedGeminiSessionId: '12345678-1234-1234-1234-123456789abc',
      linkedProviderSessionId: undefined,
      messages: []
    })
    const { deps, finishes, errors } = makeDeps({
      profiles: [makeApiKeyProfile()],
      defaultProfileId: 'profile-1',
      loadSdk: fakeSdk([{ text: 'ok' }]),
      getChat: () => chat,
      appendChatSystemMessage: () => {
        throw new Error('write failed')
      }
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    expect(errors).toEqual([])
  })
})

describe('GeminiApiProvider (combined-mode AntiGravity parameterization)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  function antigravityDeps(overrides: Parameters<typeof makeDeps>[0] = {}) {
    const made = makeDeps(overrides)
    Object.assign(made.deps, {
      providerTag: 'antigravity',
      runtimeLabel: 'gemini-api',
      usageModelId: 'gemini-api:gemini-2.5-flash',
      resolveAuthOverride: () => ({ ok: true as const, apiKey: 'antigravity-lane-key' }),
      prepareToolContext: undefined
    })
    return made
  }

  it('attributes every event, terminal transition, and usage row to the tag', async () => {
    const usageRecords: Array<Omit<UsageRecord, 'id' | 'timestamp'>> = []
    const { deps, lines, exits, finishes } = antigravityDeps({
      loadSdk: fakeSdk([
        {
          text: 'agentic ',
          usageMetadata: {
            promptTokenCount: 30,
            cachedContentTokenCount: 10,
            toolUsePromptTokenCount: 4
          }
        },
        {
          text: 'answer',
          usageMetadata: {
            candidatesTokenCount: 5,
            thoughtsTokenCount: 7,
            totalTokenCount: 42
          }
        }
      ]),
      recordUsage: (entry) => {
        usageRecords.push(entry)
      },
      getChat: () => null
    })

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)

    // Channel + payload provider tags: nothing may say 'gemini' — the
    // session-keyed event authority would drop mismatched sends, which was
    // the zombie-run failure shape this lane just escaped.
    for (const line of lines) {
      expect(line.provider).toBe('antigravity')
      if (line.payload && typeof line.payload === 'object' && 'provider' in line.payload) {
        expect(line.payload.provider).toBe('antigravity')
      }
    }
    for (const exit of exits) expect(exit.provider).toBe('antigravity')

    const initEvent = lines[0]?.payload
    expect(initEvent.type).toBe('init')
    expect(initEvent.runtime).toBe('gemini-api')

    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    expect(usageRecords).toHaveLength(1)
    expect(usageRecords[0]).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-api:gemini-2.5-flash',
      inputTokens: 20,
      cacheReadInputTokens: 10,
      outputTokens: 5,
      totalTokens: 42
    })
    const result = lines.find((line) => line.payload?.type === 'result')?.payload
    expect(result?.stats).toMatchObject({
      promptTokenCount: 30,
      cachedContentTokenCount: 10,
      toolUsePromptTokenCount: 4,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 7,
      totalTokenCount: 42,
      _taskwraith_context_usage: {
        contextTokens: 42,
        inputTokens: 30,
        freshInputTokens: 20,
        cacheReadInputTokens: 10,
        visibleOutputTokens: 5,
        reasoningTokens: 7,
        toolUsePromptTokens: 4,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })
  })

  it('bypasses the gemini profile system and runtime gate under the auth override', async () => {
    // geminiApiRuntime 'never' + zero profiles would make the legacy path
    // return false; the AntiGravity lane must still run.
    const { deps, lines, finishes } = antigravityDeps({
      settings: { geminiApiRuntime: 'never' },
      profiles: [],
      defaultProfileId: null,
      loadSdk: fakeSdk([{ text: 'ran anyway' }])
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(lines.some((line) => line.payload?.type === 'content')).toBe(true)
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
  })

  it('fails visibly with the override error and never falls back when auth is refused', async () => {
    const { deps, errors, exits, finishes, lines } = antigravityDeps({
      loadSdk: fakeSdk([{ text: 'must not stream' }])
    })
    Object.assign(deps, {
      resolveAuthOverride: () => ({
        ok: false as const,
        error: 'Gemini API key is not configured or unavailable.'
      })
    })
    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(errors).toEqual([
      { provider: 'antigravity', error: 'Gemini API key is not configured or unavailable.' }
    ])
    expect(exits).toEqual([{ provider: 'antigravity', code: 1 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'failed' }])
    expect(lines).toEqual([])
  })

  it('runs the tool loop under the tag and keeps executor routing intact', async () => {
    const { loader, callsRef } = scriptedSdk([
      [
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }]
              }
            }
          ]
        }
      ],
      [{ text: 'done reading' }]
    ])
    const { deps, lines, finishes, toolCalls } = antigravityDeps({
      loadSdk: loader,
      mcpTools: [{ name: 'read_file', description: 'Read a file', inputSchema: {} }],
      executeMcpTool: async () => ({ text: 'file contents', isError: false })
    })

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(toolCalls).toEqual([{ toolName: 'read_file', args: { path: 'a.ts' }, route: baseRoute }])
    // Two rounds hit the SDK; the tool response round carried the function
    // response back under the same conversation.
    expect(callsRef).toHaveLength(2)
    expect(finishes).toEqual([{ runId: 'run-1', status: 'completed' }])
    const contents = lines.filter((line) => line.payload?.type === 'content')
    expect(contents.map((line) => line.payload.text)).toEqual(['done reading'])
  })

  it('cancels under the tag with exit 130 when aborted mid-stream', async () => {
    const abortController: { current: AbortController | null } = { current: null }
    let requestSignal: AbortSignal | undefined
    const { deps, exits, finishes } = antigravityDeps({
      loadSdk: async () => ({
        GoogleGenAI: class {
          models = {
            generateContentStream: async (params: any) => {
              requestSignal = params.config?.abortSignal
              return (async function* () {
                yield { text: 'first' }
                abortController.current?.abort()
                yield { text: 'second' }
              })()
            }
          }
        }
      })
    })
    const originalAttach = deps.runManager.attachAbortController
    deps.runManager = {
      ...deps.runManager,
      attachAbortController: (runId, controller) => {
        abortController.current = controller as AbortController
        return originalAttach(runId, controller)
      }
    }

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)
    expect(requestSignal).toBe(abortController.current?.signal)
    expect(exits).toEqual([{ provider: 'antigravity', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })

  it('passes the owned signal to a pending SDK request and classifies its abort as Stop', async () => {
    const abortController: { current: AbortController | null } = { current: null }
    let requestSignal: AbortSignal | undefined
    let releaseRequestStarted: () => void = () => {}
    const requestStarted = new Promise<void>((resolve) => {
      releaseRequestStarted = resolve
    })
    const { deps, errors, exits, finishes } = antigravityDeps({
      loadSdk: async () => ({
        GoogleGenAI: class {
          models = {
            generateContentStream: async (params: any) => {
              requestSignal = params.config?.abortSignal
              releaseRequestStarted()
              return await new Promise((_resolve, reject) => {
                const rejectAbort = () => reject(new Error('request aborted'))
                if (requestSignal?.aborted) rejectAbort()
                else requestSignal?.addEventListener('abort', rejectAbort, { once: true })
              })
            }
          }
        }
      })
    })
    const originalAttach = deps.runManager.attachAbortController
    deps.runManager = {
      ...deps.runManager,
      attachAbortController: (runId, controller) => {
        abortController.current = controller as AbortController
        return originalAttach(runId, controller)
      }
    }

    const run = tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)
    await requestStarted
    abortController.current?.abort()
    await expect(run).resolves.toBe(true)

    expect(requestSignal).toBe(abortController.current?.signal)
    expect(errors).toEqual([])
    expect(exits).toEqual([{ provider: 'antigravity', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })

  it('passes the owned signal to files.upload and does not start inference after Stop', async () => {
    const oversized = Buffer.alloc(21 * 1024 * 1024, 0xab)
    const abortController: { current: AbortController | null } = { current: null }
    let uploadSignal: AbortSignal | undefined
    let releaseUploadStarted: () => void = () => {}
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUploadStarted = resolve
    })
    const generateContentStream = vi.fn(async () =>
      (async function* () {
        yield { text: 'must not stream' }
      })()
    )
    const { deps, exits, finishes } = antigravityDeps({
      readImageFile: async () => oversized,
      loadSdk: async () => ({
        GoogleGenAI: class {
          models = { generateContentStream }
          files = {
            upload: async (params: any) => {
              uploadSignal = params.config?.abortSignal
              releaseUploadStarted()
              return await new Promise((_resolve, reject) => {
                const rejectAbort = () => reject(new Error('upload aborted'))
                if (uploadSignal?.aborted) rejectAbort()
                else uploadSignal?.addEventListener('abort', rejectAbort, { once: true })
              })
            }
          }
        }
      })
    })
    const originalAttach = deps.runManager.attachAbortController
    deps.runManager = {
      ...deps.runManager,
      attachAbortController: (runId, controller) => {
        abortController.current = controller as AbortController
        return originalAttach(runId, controller)
      }
    }

    const run = tryRunGeminiApi(
      stubEvent,
      { ...basePayload, imagePaths: ['/tmp/huge.png'] },
      baseRoute,
      deps
    )
    await uploadStarted
    abortController.current?.abort()
    await expect(run).resolves.toBe(true)

    expect(uploadSignal).toBe(abortController.current?.signal)
    expect(generateContentStream).not.toHaveBeenCalled()
    expect(exits).toEqual([{ provider: 'antigravity', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })

  it('honours a terminal claim after an awaited tool and never opens the next SDK round', async () => {
    let runAdmitted = true
    const { loader, callsRef } = scriptedSdk([
      [
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }]
              }
            }
          ]
        }
      ],
      [{ text: 'must not stream' }]
    ])
    const { deps, exits, finishes } = antigravityDeps({
      loadSdk: loader,
      runAdmitted: () => runAdmitted,
      mcpTools: [{ name: 'read_file', description: 'Read a file', inputSchema: {} }],
      executeMcpTool: async () => {
        runAdmitted = false
        return { text: 'late result', isError: false }
      }
    })

    await expect(tryRunGeminiApi(stubEvent, basePayload, baseRoute, deps)).resolves.toBe(true)

    expect(callsRef).toHaveLength(1)
    expect(exits).toEqual([{ provider: 'antigravity', code: 130 }])
    expect(finishes).toEqual([{ runId: 'run-1', status: 'cancelled' }])
  })
})
