import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_GATEWAY_TOOL_NAMES } from '../mcp/McpToolGateway'
import { GATEWAY_V9_MCP_DIRECT_TOOLS } from '../mcp/McpToolProfiles'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import { RunManager } from '../RunManager'
import { TOKEN_COUNT_CONFIDENCE_KEY, TOKEN_COUNT_ESTIMATED } from '../../shared/tokenEstimate'
import {
  buildOllamaOpeningMessages,
  humanizeOllamaModelId,
  normalizeOllamaBaseUrl,
  normalizeOllamaModels,
  normalizeOllamaNativeToolCall,
  ollamaEmptyResponseRetryPrompt,
  ollamaEmptyToolResponseRetryPrompt,
  ollamaLocalToolSystemPrompt,
  ollamaNativeToolDefinitions,
  ollamaMalformedToolJsonNudgePrompt,
  ollamaReasoningOnlyNudgePrompt,
  ollamaToolIntentNudgePrompt,
  ollamaToolArgumentRepairPrompt,
  ollamaCeilingFinalizeContent,
  ollamaSessionMemoryKeyForRun,
  ollamaToolResultFollowUpPrompt,
  ollamaToolCallKey,
  ollamaToolResultSignature,
  evaluateOllamaRepeatedToolCall,
  ollamaRepeatedToolCallNudge,
  isOllamaNoActiveGoalToolResult,
  ollamaNoActiveGoalToolNudge,
  ollamaGoalLifecycleStopContent,
  shouldStopOllamaAfterGoalLifecycleTool,
  isDegenerateOllamaTurn,
  looksLikeDegenerateOllamaStub,
  looksLikeLeakedOllamaToolProtocol,
  looksLikeOllamaPromptRestatement,
  looksLikeOllamaToolIntent,
  ollamaDegenerateResponseNudgePrompt,
  parseJsonObjectLoose,
  parseOllamaToolRequest,
  ollamaToolCallFormatSchema,
  sanitizeLooseJsonEscapes,
  parseOllamaMemoryPsOutput,
  ollamaPreToolContentText,
  runOllamaProvider,
  prepareOllamaEnsemblePromptForRuntime,
  resolveOllamaVisibleText,
  shouldEmitOllamaReasoning,
  shouldReleaseOllamaContentDelta,
  unwrapOllamaStructuredResponseText,
  accumulateOllamaUsageStats,
  extractOllamaShowContextLength,
  getOllamaStatusSnapshot,
  ollamaUsageStats,
  validateOllamaToolArguments,
  type OllamaProviderDeps
} from './OllamaProvider'
import {
  normalizeOllamaToolControlTier,
  ollamaToolNamesForTier,
  ollamaToolRequiresIntent
} from './OllamaToolTiers'
import {
  CANVAS_EVAL_RESULT_REDACTED,
  createCanvasEvalApprovalReceipt
} from '../canvas/CanvasEvalAudit'

type SendLineCall = {
  provider: string
  payload: any
  route: AgentRunRoute | null | undefined
}

type SendErrorCall = {
  provider: string
  error: string
  route: AgentRunRoute | null | undefined
}

type SendExitCall = {
  provider: string
  code: number | null
  route: AgentRunRoute | null | undefined
}

type WorkingUsageCall = {
  stats: Record<string, unknown>
  ensembleRun: boolean
  route: AgentRunRoute
}

const stubEvent = {
  sender: { send: () => undefined }
} as unknown as Electron.IpcMainInvokeEvent

const baseRoute: AgentRunRoute = { appRunId: 'run-ollama-1', appChatId: 'chat-ollama-1' }

const basePayload: AgentRunPayload = {
  provider: 'ollama',
  scope: 'workspace',
  prompt: 'hello from the local model',
  workspace: '/tmp/taskwraith-ollama-workspace',
  appRunId: 'run-ollama-1',
  appChatId: 'chat-ollama-1'
}

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function jsonResponse(body: unknown): any {
  return {
    ok: true,
    status: 200,
    json: async () => body
  }
}

function ollamaStreamResponse(lines: string[]): any {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) {
          yield encoder.encode(`${line}\n`)
        }
      }
    }
  }
}

function delayedOllamaStreamResponse(firstLine: string, gate: Promise<void>, laterLines: string[]): any {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(`${firstLine}\n`)
        await gate
        for (const line of laterLines) {
          yield encoder.encode(`${line}\n`)
        }
      }
    }
  }
}

function makeProviderDeps(
  overrides: {
    fetchMock?: ReturnType<typeof vi.fn>
    executeTool?: OllamaProviderDeps['executeTool']
    createHostCommandProjection?: OllamaProviderDeps['createHostCommandProjection']
    canAdmitTransport?: (runId: string | undefined, requireExistingRun?: boolean) => boolean
    claimedTerminalStatus?: (
      runId: string | undefined
    ) => 'failed' | 'cancelled' | undefined
    settings?: Record<string, unknown>
  } = {}
): {
  deps: OllamaProviderDeps
  lines: SendLineCall[]
  errors: SendErrorCall[]
  exits: SendExitCall[]
  finishes: Array<{ runId: string | undefined; status: string }>
  workingUsage: WorkingUsageCall[]
} {
  const lines: SendLineCall[] = []
  const errors: SendErrorCall[] = []
  const exits: SendExitCall[] = []
  const finishes: Array<{ runId: string | undefined; status: string }> = []
  const workingUsage: WorkingUsageCall[] = []
  const fetchMock =
    overrides.fetchMock ||
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({
          details: { family: 'qwen' },
          capabilities: ['tools']
        })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
          JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 1 })
        ])
      }
      if (String(url).endsWith('/api/generate')) {
        // Best-effort unload after transport/OOM failure; tolerate in default stub.
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  vi.stubGlobal('fetch', fetchMock)

  return {
    deps: {
      getSettings: () =>
        ({
          ollamaBaseUrl: 'http://127.0.0.1:11434',
          ollamaDefaultModel: 'stream-model:latest',
          ollamaModelPreflightAt: { 'stream-model:latest@digest-stream': Date.now() },
          agenticServices: { mcpTools: 'allow' },
          geminiMcpBridgeEnabled: true,
          codexSandboxFallback: 'read-only',
          ...(overrides.settings || {})
        }) as any,
      getTotalMemoryBytes: () => 32 * 1024 ** 3,
      markOllamaModelPreflightComplete: vi.fn(),
      sendAgentCompatLine: (_sender, provider, payload, route) => {
        lines.push({ provider, payload, route })
      },
      sendAgentCompatError: (_sender, provider, error, route) => {
        errors.push({ provider, error, route })
      },
      sendAgentCompatExit: (_sender, provider, code, route) => {
        exits.push({ provider, code, route })
      },
      reportWorkingTokenUsage: (stats, context) => {
        workingUsage.push({ stats, ...context })
      },
      runManager: {
        attachAbortController: vi.fn(),
        canAdmitTransport: vi.fn(overrides.canAdmitTransport || (() => true)),
        getClaimedTerminalStatus: vi.fn(overrides.claimedTerminalStatus || (() => undefined)),
        finish: (runId, status) => {
          finishes.push({ runId, status })
          return undefined
        },
        confirmTerminalStatus: vi.fn()
      },
      emitProviderCapabilityWarnings: vi.fn(async () => undefined),
      executeTool: overrides.executeTool,
      createHostCommandProjection: overrides.createHostCommandProjection,
      getOllamaSessionMemory: vi.fn(),
      saveOllamaSessionMemory: vi.fn()
    },
    lines,
    errors,
    exits,
    finishes,
    workingUsage
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ollamaUsageStats', () => {
  it('emits canonical snake_case fields for ensemble token chips', () => {
    expect(
      ollamaUsageStats({
        prompt_eval_count: 4200,
        eval_count: 900,
        total_duration: 3_500_000_000
      })
    ).toMatchObject({
      input_tokens: 4200,
      output_tokens: 900,
      total_tokens: 5100,
      duration_ms: 3500,
      inputTokens: 4200,
      outputTokens: 900
    })
  })

  it('accumulates usage across multi-turn tool loops', () => {
    const first = accumulateOllamaUsageStats(undefined, {
      prompt_eval_count: 1200,
      eval_count: 80,
      total_duration: 1_000_000_000
    })
    const total = accumulateOllamaUsageStats(first, {
      prompt_eval_count: 900,
      eval_count: 220,
      total_duration: 2_000_000_000
    })
    expect(total).toMatchObject({
      input_tokens: 2100,
      output_tokens: 300,
      total_tokens: 2400,
      duration_ms: 3000
    })
  })
})

describe('prepareOllamaEnsemblePromptForRuntime', () => {
  it('uses ensemble budget metadata for the final provider compaction pass', () => {
    const transcript = 'x'.repeat(12_000)
    const prompt = [
      'TaskWraith Ensemble Mode',
      '',
      'Recent tagged transcript:',
      transcript,
      '',
      'Current user request:',
      'Summarize the recent panel history.'
    ].join('\n')
    const prepared = prepareOllamaEnsemblePromptForRuntime({
      prompt,
      modelId: 'ornith:35b',
      modelInfo: { id: 'ornith:35b', label: 'Ornith', contextLength: 262_144 } as any,
      contextCapTokens: 262_144,
      configuredContextChars: 16_000,
      configuredContextTurns: 8,
      toolsEnabled: false
    })

    expect(prepared).toContain(transcript)
    expect(prepared).not.toContain('[transcript compacted for Ollama context]')
  })

  it('does not fall back to the old 10K cap for unconfigured large-context ensemble runs', () => {
    const transcript = 'y'.repeat(20_000)
    const prompt = [
      'TaskWraith Ensemble Mode',
      '',
      'Recent tagged transcript:',
      transcript,
      '',
      'Current user request:',
      'Use the recent panel history.'
    ].join('\n')
    const prepared = prepareOllamaEnsemblePromptForRuntime({
      prompt,
      modelId: 'ornith:35b',
      modelInfo: { id: 'ornith:35b', label: 'Ornith', contextLength: 262_144 } as any,
      contextCapTokens: 262_144,
      toolsEnabled: false
    })

    expect(prepared).toContain(transcript)
    expect(prepared).not.toContain('[transcript compacted for Ollama context]')
  })
})

describe('runOllamaProvider streaming', () => {
  it('passes the exact run AbortSignal to model discovery, show, and chat requests', async () => {
    let attachedController: AbortController | undefined
    const requestSignals = new Map<string, AbortSignal | null | undefined>()
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      requestSignals.set(path, init?.signal)
      if (path === '/api/tags') {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (path === '/api/show') {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (path === '/api/chat') {
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Signal preserved.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 2 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({ fetchMock })
    ;(deps.runManager.attachAbortController as ReturnType<typeof vi.fn>).mockImplementation(
      (_runId: string, controller: AbortController) => {
        attachedController = controller
      }
    )

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(attachedController).toBeDefined()
    expect(requestSignals.get('/api/tags')).toBe(attachedController?.signal)
    expect(requestSignals.get('/api/show')).toBe(attachedController?.signal)
    expect(requestSignals.get('/api/chat')).toBe(attachedController?.signal)
    expect(deps.runManager.canAdmitTransport).toHaveBeenCalledWith('run-ollama-1', true)
  })

  it('does not launch model show or chat after the run gains a terminal claim', async () => {
    let admitted = true
    const requestPaths: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname
      requestPaths.push(path)
      if (path === '/api/tags') {
        admitted = false
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, errors, exits, finishes } = makeProviderDeps({
      fetchMock,
      canAdmitTransport: () => admitted
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(requestPaths).toEqual(['/api/tags'])
    expect(errors).toEqual([
      { provider: 'ollama', error: 'Ollama run cancelled.', route: baseRoute }
    ])
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'cancelled' })
  })

  it('does not launch the first chat request when Stop claims the run after show', async () => {
    let admitted = true
    let chatCalls = 0
    let unloadCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([])
      }
      if (String(url).endsWith('/api/generate')) {
        unloadCalls += 1
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'stream-model:latest',
          keep_alive: 0
        })
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, exits, finishes } = makeProviderDeps({
      fetchMock,
      canAdmitTransport: () => admitted
    })
    deps.emitProviderCapabilityWarnings = vi.fn(async () => {
      admitted = false
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(0)
    expect(unloadCalls).toBe(1)
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'cancelled' })
  })

  it('does not issue a tool-continuation chat after a terminal claim during tool execution', async () => {
    let admitted = true
    let chatCalls = 0
    let resolveTool!: (result: { ok: boolean; output: string }) => void
    const toolResult = new Promise<{ ok: boolean; output: string }>((resolve) => {
      resolveTool = resolve
    })
    const executeTool = vi.fn(() => toolResult)
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"lifecycle","path":".","maxResults":5}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 4 })
        ])
      }
      if (String(url).endsWith('/api/generate')) {
        // Cancel-after-launch best-effort unload.
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, exits, finishes } = makeProviderDeps({
      fetchMock,
      executeTool,
      canAdmitTransport: () => admitted,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      }
    })
    const runPromise = runOllamaProvider(deps, stubEvent, basePayload, baseRoute)
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledOnce())

    admitted = false
    resolveTool({ ok: true, output: 'src/main/lifecycle.ts:1: claimed' })
    await runPromise

    expect(chatCalls).toBe(1)
    expect(
      lines.some(
        (line) =>
          line.payload.type === 'tool_result' &&
          line.payload.tool_name === 'workspace_search'
      )
    ).toBe(false)
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'cancelled' })
  })

  it('does not interpret a tool request after the resolved chat turn gains a terminal claim', async () => {
    let admitted = true
    let chatCalls = 0
    const encoder = new TextEncoder()
    const executeTool = vi.fn(async () => ({ ok: true, output: 'must not run' }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return {
          ok: true,
          status: 200,
          body: {
            async *[Symbol.asyncIterator]() {
              yield encoder.encode(
                `${JSON.stringify({
                  message: {
                    role: 'assistant',
                    content:
                      '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"resolved claim","path":".","maxResults":5}}}'
                  }
                })}\n`
              )
              yield encoder.encode(
                `${JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 4 })}\n`
              )
              admitted = false
            }
          }
        }
      }
      if (String(url).endsWith('/api/generate')) {
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, exits, finishes } = makeProviderDeps({
      fetchMock,
      executeTool,
      canAdmitTransport: () => admitted,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      }
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(1)
    expect(executeTool).not.toHaveBeenCalled()
    expect(lines.some((line) => line.payload.tool_name === 'workspace_search')).toBe(false)
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'cancelled' }])
  })

  it('rechecks a re-entrant terminal claim immediately before tool dispatch', async () => {
    let admitted = true
    let chatCalls = 0
    const executeTool = vi.fn(async () => ({ ok: true, output: 'must not run' }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"reentrant claim","path":".","maxResults":5}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 4 })
        ])
      }
      if (String(url).endsWith('/api/generate')) {
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, exits, finishes } = makeProviderDeps({
      fetchMock,
      executeTool,
      canAdmitTransport: () => admitted,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      }
    })
    const sendLine = deps.sendAgentCompatLine
    deps.sendAgentCompatLine = (sender, provider, line, route) => {
      sendLine(sender, provider, line, route)
      if (line.type === 'tool_use' && line.tool_name === 'workspace_search') {
        admitted = false
      }
    }

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(1)
    expect(executeTool).not.toHaveBeenCalled()
    expect(
      lines.some(
        (line) =>
          line.payload.type === 'tool_result' &&
          line.payload.tool_name === 'workspace_search'
      )
    ).toBe(false)
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'cancelled' }])
  })

  it('settles a completed run exactly once when result projection throws', async () => {
    const { deps, finishes } = makeProviderDeps()
    const sendLine = deps.sendAgentCompatLine
    deps.sendAgentCompatLine = (sender, provider, line, route) => {
      if (line.type === 'result') throw new Error('result projection failed')
      sendLine(sender, provider, line, route)
    }

    await expect(
      runOllamaProvider(deps, stubEvent, basePayload, baseRoute)
    ).rejects.toThrow('result projection failed')

    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'completed' }])
  })

  it('settles a failed run exactly once when error projection throws', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([JSON.stringify({ error: 'provider failed' })])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, finishes } = makeProviderDeps({ fetchMock })
    deps.sendAgentCompatError = () => {
      throw new Error('error projection failed')
    }

    await expect(
      runOllamaProvider(deps, stubEvent, basePayload, baseRoute)
    ).rejects.toThrow('error projection failed')

    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'failed' }])
  })

  it('settles a cancelled run exactly once when exit projection throws', async () => {
    let admitted = true
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        admitted = false
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, finishes } = makeProviderDeps({
      fetchMock,
      canAdmitTransport: () => admitted
    })
    deps.sendAgentCompatExit = () => {
      throw new Error('exit projection failed')
    }

    await expect(
      runOllamaProvider(deps, stubEvent, basePayload, baseRoute)
    ).rejects.toThrow('exit projection failed')

    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'cancelled' }])
  })

  it('joins graph lifecycle settlement when terminal result projection throws', async () => {
    const runManager = new RunManager()
    runManager.create({
      runId: 'run-ollama-1',
      provider: 'ollama',
      appChatId: 'chat-ollama-1',
      status: 'running'
    })
    runManager.requireTerminalConfirmation('run-ollama-1')
    const { deps } = makeProviderDeps()
    deps.runManager = runManager
    const sendLine = deps.sendAgentCompatLine
    deps.sendAgentCompatLine = (sender, provider, line, route) => {
      if (line.type === 'result') throw new Error('graph result projection failed')
      sendLine(sender, provider, line, route)
    }

    await expect(
      runOllamaProvider(deps, stubEvent, basePayload, baseRoute)
    ).rejects.toThrow('graph result projection failed')

    expect(runManager.get('run-ollama-1')?.status).toBe('completed')
    expect(runManager.getTerminalJoinState('run-ollama-1')).toEqual({
      required: false,
      conflict: false
    })
  })

  it('preserves a failed graph claim instead of projecting it as Stop', async () => {
    let admitted = true
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        admitted = false
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, errors, exits, finishes } = makeProviderDeps({
      fetchMock,
      canAdmitTransport: () => admitted,
      claimedTerminalStatus: () => 'failed'
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(errors[0]?.error).toContain('cancelled before transport launch')
    expect(exits).toEqual([{ provider: 'ollama', code: 1, route: baseRoute }])
    expect(finishes).toEqual([{ runId: 'run-ollama-1', status: 'failed' }])
  })

  it('uses the ensemble-aware harness kickoff for live ensemble dispatches', async () => {
    const chatBodies: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatBodies.push(String(init?.body || ''))
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will follow the ensemble role contract and continue with the assigned slice.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 2 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool: async () => ({ ok: true, output: '' })
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: [
          'TaskWraith Ensemble Mode',
          'Role boundary contract:',
          '- Treat Boss routing as authoritative.',
          'Current user request:',
          'Continue the plan arc.'
        ].join('\n'),
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'participant-ollama',
          provider: 'ollama',
          role: 'SliceWorker',
          order: 9,
          ensembleContextChars: 24000,
          ensembleContextTurns: 8
        }
      },
      baseRoute
    )

    expect(chatBodies).toHaveLength(1)
    const messagesText = chatBodies[0]
    expect(messagesText).toContain('TaskWraith Ensemble Mode')
    expect(messagesText).toContain('complete TaskWraith Ensemble instruction block')
    expect(messagesText).toContain('Boss/Bossman/Lead authority rules')
    expect(messagesText).not.toContain('Your task is the user request')
  })

  it('keeps ensemble authority salient after Ollama tool results', async () => {
    let chatCalls = 0
    const chatBodies: string[] = []
    const executeTool = vi.fn(async () => ({
      ok: true,
      output: 'src/main/EnsemblePrompt.ts:599: TaskWraith Ensemble Mode'
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(String(init?.body || ''))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content:
                  '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"TaskWraith Ensemble Mode","path":".","maxResults":5}}}'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 4 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I found the relevant ensemble prompt lines and will stay within my assigned role.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: [
          'TaskWraith Ensemble Mode',
          'Role boundary contract:',
          '- Treat Boss routing as authoritative.',
          'Current user request:',
          'Check prompt parity.'
        ].join('\n'),
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'participant-ollama',
          provider: 'ollama',
          role: 'SliceWorker',
          order: 9
        }
      },
      baseRoute
    )

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(chatBodies).toHaveLength(2)
    expect(chatBodies[1]).toContain('assigned ensemble role')
    expect(chatBodies[1]).toContain('Boss/Bossman/Lead routing')
  })

  it('loads and saves Ollama ensemble memory by participant seat key', async () => {
    let chatCalls = 0
    const executeTool = vi.fn(async () => ({
      ok: true,
      output: 'src/main/EnsemblePrompt.ts:1: identity fix'
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls === 1) {
          expect(String(init?.body || '')).toContain('TaskWraith Ensemble Mode')
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content:
                  '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"identity fix","path":".","maxResults":5}}}'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 4 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'LFM stayed in its own seat memory.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: 'TaskWraith Ensemble Mode\n\nCurrent user request:\nCheck identity isolation.',
        ensembleRun: {
          roundId: 'round-identity',
          participantId: 'lfm-seat',
          provider: 'ollama',
          role: 'LFM',
          order: 3,
          ensembleContextChars: 24000,
          ensembleContextTurns: 8
        }
      },
      baseRoute
    )

    expect(deps.getOllamaSessionMemory).toHaveBeenCalledWith(
      'chat-ollama-1',
      'ensemble:lfm-seat'
    )
    expect(deps.saveOllamaSessionMemory).toHaveBeenCalledWith(
      'chat-ollama-1',
      expect.objectContaining({
        modelId: 'stream-model:latest',
        toolTurnCount: 1
      }),
      'ensemble:lfm-seat'
    )
  })

  it('keeps the live gateway canvas_eval result while redacting saved trajectory', async () => {
    let chatCalls = 0
    const chatBodies: any[] = []
    const script = 'throw new Error("OLLAMA_GATEWAY_SCRIPT_SECRET")'
    const resultSecret = 'OLLAMA_GATEWAY_ERROR_SECRET'
    const receipt = createCanvasEvalApprovalReceipt(script, 'approval-capability-invoke')
    const toolArgs = {
      name: 'canvas_eval',
      arguments: { canvasId: 'canvas-gateway', script }
    }
    const executeTool = vi.fn(async () => ({
      ok: false,
      output: `${resultSecret}: exact live response`,
      structuredContent: { secret: resultSecret },
      canvasEvalApproval: receipt
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(JSON.parse(String(init?.body || '{}')))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                tool_calls: [
                  { function: { name: 'capability_invoke', arguments: toolArgs } }
                ]
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 8 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Canvas call handled.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 16, eval_count: 5 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(executeTool).toHaveBeenCalledTimes(1)
    // The immediate tool response sent back to the live model remains exact.
    expect(JSON.stringify(chatBodies[1]?.messages)).toContain(resultSecret)

    const saved = (deps.saveOllamaSessionMemory as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    const serialized = JSON.stringify(saved)
    expect(serialized).not.toContain(script)
    expect(serialized).not.toContain(resultSecret)
    expect(serialized).toContain(CANVAS_EVAL_RESULT_REDACTED)
    expect(saved.trajectory?.[0]).toMatchObject({
      effectiveToolName: 'canvas_eval',
      canvasEvalReceipt: receipt
    })
  })

  it('keeps ensemble authority salient after empty Ollama turns', async () => {
    let chatCalls = 0
    const chatBodies: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(String(init?.body || ''))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({ message: { role: 'assistant', content: '' } }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 0 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will answer from my assigned ensemble participant role.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool: async () => ({ ok: true, output: '' })
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: [
          'TaskWraith Ensemble Mode',
          'Role boundary contract:',
          '- Treat Boss routing as authoritative.',
          'Current user request:',
          'Check empty-turn retry parity.'
        ].join('\n'),
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'participant-ollama',
          provider: 'ollama',
          role: 'SliceWorker',
          order: 9
        }
      },
      baseRoute
    )

    expect(chatBodies).toHaveLength(2)
    expect(chatBodies[1]).toContain('assigned participant')
    expect(chatBodies[1]).toContain('Boss/Bossman/Lead routing')
    expect(chatBodies[1]).toContain('assigned participant role')
  })

  it('keeps ensemble authority salient after tool-intent stubs', async () => {
    let chatCalls = 0
    const chatBodies: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(String(init?.body || ''))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: { role: 'assistant', content: 'I should use workspace_search now.' }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 6 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will answer from my assigned role with the next local step.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool: async () => ({ ok: true, output: '' })
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: [
          'TaskWraith Ensemble Mode',
          'Role boundary contract:',
          '- Treat Boss routing as authoritative.',
          'Current user request:',
          'Check tool-intent retry parity.'
        ].join('\n'),
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'participant-ollama',
          provider: 'ollama',
          role: 'SliceWorker',
          order: 9
        }
      },
      baseRoute
    )

    expect(chatBodies).toHaveLength(2)
    expect(chatBodies[1]).toContain('assigned participant')
    expect(chatBodies[1]).toContain('Boss/Bossman/Lead routing')
    expect(chatBodies[1]).toContain('assigned participant role')
  })

  it('emits content deltas before the Ollama HTTP stream finishes', async () => {
    const gate = makeDeferred()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return delayedOllamaStreamResponse(
          JSON.stringify({
            message: { role: 'assistant', content: 'This is a streamed Ollama answer ' }
          }),
          gate.promise,
          [
            JSON.stringify({ message: { role: 'assistant', content: 'with a second chunk.' } }),
            JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 12 })
          ]
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, workingUsage } = makeProviderDeps({ fetchMock })
    const runPromise = runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    await new Promise((resolve) => setImmediate(resolve))
    let assertionError: unknown
    try {
      const contentTexts = lines
        .filter((line) => line.payload.type === 'content')
        .map((line) => line.payload.text)
      expect(contentTexts).toEqual(['This is a streamed Ollama answer '])
      expect(workingUsage.at(-1)).toMatchObject({
        stats: {
          input_tokens: 0,
          output_tokens: 9,
          total_tokens: 9,
          [TOKEN_COUNT_CONFIDENCE_KEY]: TOKEN_COUNT_ESTIMATED
        },
        route: baseRoute
      })
    } catch (error) {
      assertionError = error
    } finally {
      gate.resolve()
      await runPromise
    }
    if (assertionError) throw assertionError

    const finalContentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(finalContentTexts).toEqual(['This is a streamed Ollama answer ', 'with a second chunk.'])
    expect(workingUsage.at(-1)?.stats).toMatchObject({
      input_tokens: 4,
      output_tokens: 12,
      total_tokens: 16
    })
    expect(workingUsage.at(-1)?.stats).not.toHaveProperty(TOKEN_COUNT_CONFIDENCE_KEY)
    expect(lines.at(-1)?.payload.type).toBe('result')
  })

  it('keeps reasoning-looking ordinary answer text in the answer channel', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools', 'thinking']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({
          details: { family: 'qwen' },
          capabilities: ['tools', 'thinking']
        })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'Thinking Process: this is provider-authored answer text.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(
      lines
        .filter((line) => line.payload.type === 'content')
        .map((line) => line.payload.text)
        .join('')
    ).toBe('Thinking Process: this is provider-authored answer text.')
    expect(lines.some((line) => line.payload.tool_name === 'ollama_thinking')).toBe(false)
  })

  it('keeps working-telemetry projection failures outside the provider outcome', async () => {
    const { deps, lines, exits, finishes } = makeProviderDeps()
    deps.reportWorkingTokenUsage = () => {
      throw new Error('working telemetry unavailable')
    }

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(lines.at(-1)?.payload).toMatchObject({ type: 'result', status: 'success' })
    expect(exits).toEqual([{ provider: 'ollama', code: 0, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'completed' })
  })

  it('fails the run for a valid Ollama error stream chunk', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([JSON.stringify({ error: 'model not found' })])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, errors, exits, finishes } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(errors).toEqual([{ provider: 'ollama', error: 'model not found', route: baseRoute }])
    expect(exits).toEqual([{ provider: 'ollama', code: 1, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'failed' })
    expect(lines.some((line) => line.payload.type === 'result')).toBe(false)
  })

  it('fails the run when an Ollama error arrives after streamed content', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([
          JSON.stringify({
            message: { role: 'assistant', content: 'Partial answer before failure. ' }
          }),
          JSON.stringify({ error: 'runner crashed' })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, errors, exits, finishes } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(
      lines.filter((line) => line.payload.type === 'content').map((line) => line.payload.text)
    ).toEqual(['Partial answer before failure. '])
    expect(errors).toEqual([{ provider: 'ollama', error: 'runner crashed', route: baseRoute }])
    expect(exits).toEqual([{ provider: 'ollama', code: 1, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'failed' })
    expect(lines.some((line) => line.payload.type === 'result')).toBe(false)
  })

  it('retries a transient Ollama chat transport failure before failing the run', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls === 1) throw new TypeError('fetch failed')
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Recovered locally.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 8 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, errors, exits, finishes } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(2)
    expect(errors).toEqual([])
    expect(exits).toEqual([{ provider: 'ollama', code: 0, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'completed' })
    expect(lines.some((line) => line.payload.id === 'ollama-chat-transport-retry')).toBe(true)
    expect(
      lines.filter((line) => line.payload.type === 'content').map((line) => line.payload.text)
    ).toEqual(['Recovered locally.'])
  })

  it('explains repeated Ollama transport failures instead of surfacing raw fetch failed', async () => {
    let chatCalls = 0
    let unloadCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        throw new TypeError('fetch failed')
      }
      if (String(url).endsWith('/api/generate')) {
        unloadCalls += 1
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'stream-model:latest',
          keep_alive: 0
        })
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, errors, exits, finishes } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(3)
    expect(unloadCalls).toBe(1)
    expect(lines.filter((line) => line.payload.id === 'ollama-chat-transport-retry')).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('Ollama connection dropped')
    expect(errors[0].error).toContain('memory pressure')
    expect(errors[0].error).toContain('requested an unload')
    expect(errors[0].error).toContain('Original error: fetch failed')
    expect(errors[0].error).not.toBe('fetch failed')
    expect(exits).toEqual([{ provider: 'ollama', code: 1, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'failed' })
  })

  it('unloads the launched model when a claimed-cancelled run fails transport launch', async () => {
    let chatCalls = 0
    let unloadCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        throw new TypeError('fetch failed')
      }
      if (String(url).endsWith('/api/generate')) {
        unloadCalls += 1
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'stream-model:latest',
          keep_alive: 0
        })
        return {
          ok: true,
          status: 200,
          text: async () => ''
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, errors, exits, finishes } = makeProviderDeps({
      fetchMock,
      claimedTerminalStatus: () => 'cancelled'
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatCalls).toBe(3)
    expect(unloadCalls).toBe(1)
    expect(errors).toEqual([{ provider: 'ollama', error: 'Ollama run cancelled.', route: baseRoute }])
    expect(exits).toEqual([{ provider: 'ollama', code: 130, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'cancelled' })
  })

  it('does not stream a degenerate stub that is rejected and retried', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({ message: { role: 'assistant', content: 'The' } }),
            JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 1 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'This retry is a complete streamed answer.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 7, eval_count: 10 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toEqual(['This retry is a complete streamed answer.'])
    expect(contentTexts).not.toContain('The')
  })

  it('does not stream raw JSON fallback tool protocol blobs', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls > 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content: 'README was read without leaking the tool blob.'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"read_file","arguments":{"path":"README.md"}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool: async () => ({ ok: true, output: 'README body' })
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(chatCalls).toBe(2)
    expect(contentTexts.some((text) => /taskwraith_tool|read_file/.test(text))).toBe(false)
    expect(lines.some((line) => line.payload.type === 'tool_use')).toBe(true)
  })

  it('does not leak split-prefix JSON fallback tool protocol blobs', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls > 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content: 'README was read without leaking the split tool blob.'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will use '
            }
          }),
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                'read_file now. {"taskwraith_tool":{"name":"read_file","arguments":{"path":"README.md"}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool: async () => ({ ok: true, output: 'README body' })
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(chatCalls).toBe(2)
    expect(contentTexts.join('\n')).not.toMatch(/I will use|taskwraith_tool|read_file/)
    expect(lines.some((line) => line.payload.type === 'tool_use')).toBe(true)
  })

  it('uses a narrow repair prompt for arg-invalid JSON fallback tool calls', async () => {
    let chatCalls = 0
    const chatBodies: any[] = []
    const executeTool = vi.fn(async () => ({
      ok: false,
      output:
        'Your read_file call is missing required argument: path. Re-issue the read_file tool call with "path" set.',
      validationError: true
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(JSON.parse(String(init?.body || '{}')))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content: '{"taskwraith_tool":{"name":"read_file","arguments":{}}}'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I can repair the missing path argument before continuing.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(chatBodies).toHaveLength(2)
    const repairTurn = JSON.stringify(chatBodies[1].messages)
    expect(repairTurn).toContain('TaskWraith rejected read_file before execution')
    expect(repairTurn).toContain('Re-issue the same read_file tool call')
    expect(repairTurn).not.toContain('The tool failed.')
    expect(
      lines.filter((line) => line.payload.type === 'content').map((line) => line.payload.text)
    ).toEqual(['I can repair the missing path argument before continuing.'])
  })

  it('stops repeated arg-invalid tool calls instead of looping forever', async () => {
    let chatCalls = 0
    const executeTool = vi.fn(async () => ({
      ok: false,
      output:
        'Your read_file call is missing required argument: path. Re-issue the read_file tool call with "path" set.',
      validationError: true
    }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '{"taskwraith_tool":{"name":"read_file","arguments":{}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, exits, finishes } = makeProviderDeps({
      fetchMock,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      },
      executeTool
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(chatCalls).toBe(4)
    expect(executeTool).toHaveBeenCalledTimes(4)
    expect(contentTexts).toHaveLength(1)
    expect(contentTexts[0]).toContain('stopping instead of looping')
    expect(exits).toEqual([{ provider: 'ollama', code: 0, route: baseRoute }])
    expect(finishes).toContainEqual({ runId: 'run-ollama-1', status: 'completed' })
  })

  it('does not stream raw structured response envelopes before unwrapping', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '{"analysis":"private","response":"Visible structured answer."}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 14 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toEqual(['Visible structured answer.'])
  })

  it('streams native pre-tool prose and post-tool final answer in order', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content: 'I will inspect the requested file before answering. '
              }
            }),
            JSON.stringify({
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    function: {
                      name: 'read_file',
                      arguments: { path: 'README.md' }
                    }
                  }
                ]
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 8 })
          ])
        }
        return delayedOllamaStreamResponse(
          JSON.stringify({
            message: { role: 'assistant', content: 'The README says TaskWraith ' }
          }),
          Promise.resolve(),
          [
            JSON.stringify({ message: { role: 'assistant', content: 'runs local agents.' } }),
            JSON.stringify({ done: true, prompt_eval_count: 16, eval_count: 12 })
          ]
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    let projectedLines: SendLineCall[] = []
    const lifecycleEvents: string[] = []
    const createHostCommandProjection = vi.fn(() => ({
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        lifecycleEvents.push('run')
        return operation()
      },
      complete: () => {
        expect(
          projectedLines.some(
            (line) => line.payload.type === 'tool_result' && line.payload.tool_name === 'read_file'
          )
        ).toBe(true)
        lifecycleEvents.push('complete-after-tool-result')
      }
    }))
    const prepared = makeProviderDeps({
      fetchMock,
      executeTool: async () => ({ ok: true, output: 'TaskWraith runs local agents.' }),
      createHostCommandProjection
    })
    const { deps, lines } = prepared
    projectedLines = lines

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(createHostCommandProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        appRunId: baseRoute.appRunId,
        appChatId: baseRoute.appChatId,
        workspacePath: basePayload.workspace,
        toolName: 'read_file'
      })
    )
    expect(lifecycleEvents).toEqual(['run', 'complete-after-tool-result'])

    const ordered = lines
      .filter((line) => ['content', 'tool_use', 'tool_result', 'result'].includes(line.payload.type))
      .map((line) =>
        line.payload.type === 'content' ? `content:${line.payload.text}` : line.payload.type
      )
    expect(ordered).toEqual([
      'content:I will inspect the requested file before answering. ',
      'tool_use',
      'tool_result',
      'content:The README says TaskWraith ',
      'content:runs local agents.',
      'result'
    ])
  })

  it('recovers from no-active-goal lifecycle tool failures without forcing a handoff', async () => {
    let chatCalls = 0
    const chatBodies: any[] = []
    const executeTool = vi.fn(async () => ({
      ok: false,
      output:
        '{"ok":false,"tool":"update_goal","error":"No active TaskWraith goal is set for this chat."}'
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'ornith:9b',
              digest: 'digest-ornith',
              details: { family: 'ornith' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'ornith' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(JSON.parse(String(init?.body || '{}')))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    function: {
                      name: 'update_goal',
                      arguments: { status: 'active', reason: 'Setting up test environment.' }
                    }
                  }
                ]
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 8 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will continue locally with the available workspace tools.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 18, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({
      fetchMock,
      executeTool,
      settings: { ollamaDefaultModel: 'ornith:9b' }
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      { ...basePayload, model: 'ornith:9b', prompt: 'add tests locally' },
      baseRoute
    )

    expect(executeTool).toHaveBeenCalledTimes(1)
    const rawToolResults = lines
      .filter((line) => line.payload.type === 'tool_result' && line.payload.tool_name === 'update_goal')
      .map((line) => line.payload.output)
    expect(rawToolResults).toEqual([
      '{"ok":false,"tool":"update_goal","error":"No active TaskWraith goal is set for this chat."}'
    ])
    expect(JSON.stringify(chatBodies[1].messages)).toContain('Do NOT call update_goal')
    expect(JSON.stringify(chatBodies[1].messages)).toContain('not todo lists')
    expect(
      lines
        .filter((line) => line.payload.type === 'content')
        .map((line) => line.payload.text)
    ).toEqual(['I will continue locally with the available workspace tools.'])
    expect(
      lines.some(
        (line) =>
          line.payload.type === 'provider_warning' &&
          String(line.payload.message || '').includes('Codex or Claude')
      )
    ).toBe(false)
  })

  it('keeps ensemble authority salient after no-active-goal tool failures', async () => {
    let chatCalls = 0
    const chatBodies: string[] = []
    const executeTool = vi.fn(async () => ({
      ok: false,
      output:
        '{"ok":false,"tool":"update_goal","error":"No active TaskWraith goal is set for this chat."}'
    }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(String(init?.body || ''))
        if (chatCalls === 1) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content:
                  '{"taskwraith_tool":{"name":"update_goal","arguments":{"status":"active","reason":"Setting up test environment."}}}'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 8 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'I will continue within my assigned ensemble slice.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 12 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({
      fetchMock,
      executeTool,
      settings: {
        ollamaRunProfiles: {
          'stream-model:latest': { protocolMode: 'json_only' }
        }
      }
    })

    await runOllamaProvider(
      deps,
      stubEvent,
      {
        ...basePayload,
        prompt: [
          'TaskWraith Ensemble Mode',
          'Role boundary contract:',
          '- Treat Boss routing as authoritative.',
          'Current user request:',
          'add tests locally'
        ].join('\n'),
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'participant-ollama',
          provider: 'ollama',
          role: 'SliceWorker',
          order: 9
        }
      },
      baseRoute
    )

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(chatBodies).toHaveLength(2)
    expect(chatBodies[1]).toContain('Do NOT call update_goal')
    expect(chatBodies[1]).toContain('assigned ensemble slice')
    expect(chatBodies[1]).toContain('Boss/Bossman/Lead routing')
    expect(
      lines
        .filter((line) => line.payload.type === 'content')
        .map((line) => line.payload.text)
    ).toEqual(['I will continue within my assigned ensemble slice.'])
  })

  it('streams visible Ollama thinking once public content is flowing', async () => {
    const gate = makeDeferred()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return delayedOllamaStreamResponse(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'This answer is already public content. ',
              thinking: 'Reasoning about the public answer. '
            }
          }),
          gate.promise,
          [
            JSON.stringify({
              message: {
                role: 'assistant',
                content: 'Now finishing.',
                thinking: 'Done.'
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 16 })
          ]
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock })
    const runPromise = runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    await new Promise((resolve) => setImmediate(resolve))
    let assertionError: unknown
    try {
      const thinkingUse = lines.find((line) => line.payload.tool_name === 'ollama_thinking')
      const thinkingResults = lines
        .filter((line) => line.payload.tool_name === 'ollama_thinking' && line.payload.type === 'tool_result')
        .map((line) => line.payload.output)
      expect(thinkingUse?.payload.type).toBe('tool_use')
      expect(thinkingResults).toEqual(['Reasoning about the public answer. '])
    } catch (error) {
      assertionError = error
    } finally {
      gate.resolve()
      await runPromise
    }
    if (assertionError) throw assertionError

    const thinkingResults = lines
      .filter((line) => line.payload.tool_name === 'ollama_thinking' && line.payload.type === 'tool_result')
      .map((line) => line.payload.output)
    expect(thinkingResults).toEqual([
      'Reasoning about the public answer. ',
      'Reasoning about the public answer. Done.'
    ])
    expect(
      lines.filter((line) => line.payload.tool_name === 'ollama_thinking' && line.payload.type === 'tool_use')
    ).toHaveLength(1)
  })

  it('does not leak split-prefix prompt restatement thinking', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'This answer is already public content. ',
              thinking: 'Workspace '
            }
          }),
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'Done.',
              thinking: 'coding task: inspect files internally.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 16 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines, workingUsage } = makeProviderDeps({ fetchMock })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(lines.filter((line) => line.payload.tool_name === 'ollama_thinking')).toEqual([])
    expect(
      workingUsage.some((call) => call.stats[TOKEN_COUNT_CONFIDENCE_KEY] === TOKEN_COUNT_ESTIMATED)
    ).toBe(true)
    expect(JSON.stringify(workingUsage)).not.toContain('inspect files internally')
  })

  it('does not stream thinking-only text that becomes the visible answer', async () => {
    const gate = makeDeferred()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        return delayedOllamaStreamResponse(
          JSON.stringify({
            message: {
              role: 'assistant',
              thinking: 'This thinking-only answer should be promoted after completion.'
            }
          }),
          gate.promise,
          [JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 10 })]
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock })
    const runPromise = runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    await new Promise((resolve) => setImmediate(resolve))
    let assertionError: unknown
    try {
      expect(lines.some((line) => line.payload.tool_name === 'ollama_thinking')).toBe(false)
      expect(lines.some((line) => line.payload.type === 'content')).toBe(false)
    } catch (error) {
      assertionError = error
    } finally {
      gate.resolve()
      await runPromise
    }
    if (assertionError) throw assertionError

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toEqual(['This thinking-only answer should be promoted after completion.'])
    expect(lines.some((line) => line.payload.tool_name === 'ollama_thinking')).toBe(false)
  })

  it('stops tool-enabled thinking-only loops after repeated non-productive turns', async () => {
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              thinking: 'Workspace coding task: I should inspect files internally.'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 10 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock, executeTool: async () => ({ ok: true, output: '' }) })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(chatCalls).toBe(4)
    expect(contentTexts).toHaveLength(1)
    expect(contentTexts[0]).toContain('stopping instead of looping')
    expect(contentTexts.join('\n')).not.toContain('Workspace coding task')
    expect(lines.some((line) => line.payload.type === 'provider_warning')).toBe(false)
  })

  it('stops a model that re-hits the harness gate every turn (block is not progress)', async () => {
    let chatCalls = 0
    // The model insists on read_file before any explore, so the harness gate
    // blocks it every turn (no tool ever executes). A harness block is a
    // pre-execution redirect, not progress, so it must feed the retry ceiling —
    // otherwise this loops forever. executeTool must never be reached.
    const executeTool = vi.fn(async () => ({ ok: true, output: 'should never run' }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"read_file","arguments":{"path":"src/deep/module.ts"}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 6 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(executeTool).not.toHaveBeenCalled()
    expect(chatCalls).toBe(4)
    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toHaveLength(1)
    expect(contentTexts[0]).toContain('stopping instead of looping')
  }, 10000)

  it('stops a tool that keeps failing the SAME way instead of looping for hours', async () => {
    let chatCalls = 0
    // The model re-issues the same shell command and the tool fails identically
    // every time (the 2026-07-28 QA 82-minute error loop). An executed failure
    // is progress the first two times (real iteration loops look like that);
    // an unchanged failure streak must stop crediting the turn so the retry
    // ceiling finalizes. Streak math: failures 1-2 productive, 3-6 feed the
    // 4-turn ceiling, turn 7 never dispatches → 6 chat turns, 6 executions.
    const executeTool = vi.fn(async () => ({
      ok: false,
      output: 'python3: command exited 1: ModuleNotFoundError: tidepool'
    }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"run_shell_command","arguments":{"command":"python3 tidepool.py rain"}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 6 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(executeTool).toHaveBeenCalledTimes(6)
    expect(chatCalls).toBe(6)
    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts).toHaveLength(1)
    expect(contentTexts[0]).toContain('stopping instead of looping')
  }, 10000)

  it('keeps crediting a tool whose failures CHANGE (real debugging never trips the streak)', async () => {
    let chatCalls = 0
    // Same tool, but a different error each attempt, then success — the streak
    // must reset on every distinct failure and clear on success, so the run
    // finalizes normally via the model's closing answer, not the ceiling.
    const executeTool = vi.fn(async () => ({
      ok: chatCalls >= 4,
      output: chatCalls >= 4 ? 'ok' : `attempt ${chatCalls} failed differently`
    }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        if (chatCalls >= 5) {
          return ollamaStreamResponse([
            JSON.stringify({
              message: { role: 'assistant', content: 'All fixed after iterating.' }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 6 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '{"taskwraith_tool":{"name":"run_shell_command","arguments":{"command":"python3 tidepool.py rain"}}}'
            }
          }),
          JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 6 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps, lines } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(executeTool).toHaveBeenCalledTimes(4)
    const contentTexts = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
    expect(contentTexts.join('\n')).toContain('All fixed after iterating.')
    expect(contentTexts.join('\n')).not.toContain('stopping instead of looping')
  }, 10000)

  it('constrains json-fallback decoding to the compact gateway surface', async () => {
    // Regression: the constrained-decoding grammar must allow every EXECUTABLE
    // tool (so a model can name a tail tool discovered via tool_help), even
    // though only the gateway direct set is ADVERTISED. If the grammar enum were the
    // advertised set, a json-path model could never emit e.g. git_blame.
    // A model without native 'tools' support is pinned to the json-fallback path.
    const chatBodies: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['completion']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['completion'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatBodies.push(String(init?.body || ''))
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Done.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 2 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      executeTool: async () => ({ ok: true, output: '' })
    })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    expect(chatBodies).toHaveLength(1)
    const format = JSON.parse(chatBodies[0]).format
    const enumNames: string[] = format?.properties?.taskwraith_tool?.properties?.name?.enum
    expect(Array.isArray(enumNames)).toBe(true)
    expect(enumNames).toEqual([
      ...GATEWAY_V9_MCP_DIRECT_TOOLS,
      ...CAPABILITY_GATEWAY_TOOL_NAMES,
      'tool_help'
    ])
    expect(enumNames).not.toContain('git_blame')
  })

  it('does not advertise edit/shell native tools to a read-only seat', async () => {
    const chatBodies: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatBodies.push(String(init?.body || ''))
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Reading only.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 2 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({ fetchMock, executeTool: async () => ({ ok: true, output: '' }) })

    await runOllamaProvider(
      deps,
      stubEvent,
      { ...basePayload, effectivePermissions: { readOnly: true } as any },
      baseRoute
    )

    expect(chatBodies).toHaveLength(1)
    const toolNames: string[] = (JSON.parse(chatBodies[0]).tools || []).map(
      (t: any) => t.function?.name
    )
    // Reads stay; edits + shell are gone (they'd only be denied for this seat).
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('tool_help')
    expect(toolNames).not.toContain('write_file')
    expect(toolNames).not.toContain('replace')
    expect(toolNames).not.toContain('run_shell_command')
    expect(toolNames).not.toContain('run_task')
  })

  it('keys ensemble session memory per participant seat (no cross-seat leak)', async () => {
    const store = new Map<string, unknown>()
    const getKeys: Array<string | undefined> = []
    const saveKeys: Array<string | undefined> = []
    let chatCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        // Odd calls: a workspace_search tool call (so the run persists memory).
        // Even calls: a final answer so the seat's run terminates.
        return chatCalls % 2 === 1
          ? ollamaStreamResponse([
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content:
                    '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"seat marker","path":".","maxResults":3}}}'
                }
              }),
              JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 4 })
            ])
          : ollamaStreamResponse([
              JSON.stringify({ message: { role: 'assistant', content: 'Done for my slice.' } }),
              JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 4 })
            ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({
      fetchMock,
      settings: { ollamaRunProfiles: { 'stream-model:latest': { protocolMode: 'json_only' } } },
      executeTool: async () => ({ ok: true, output: 'src/seat.ts:1: seat marker' })
    })
    deps.getOllamaSessionMemory = (chatId: string, memoryKey?: string) => {
      getKeys.push(memoryKey)
      return store.get(`${chatId}::${memoryKey ?? ''}`) as never
    }
    deps.saveOllamaSessionMemory = (chatId: string, memory: unknown, memoryKey?: string) => {
      saveKeys.push(memoryKey)
      store.set(`${chatId}::${memoryKey ?? ''}`, memory)
    }

    const runSeat = (participantId: string) =>
      runOllamaProvider(
        deps,
        stubEvent,
        {
          ...basePayload,
          ensembleRun: {
            roundId: 'round-1',
            participantId,
            provider: 'ollama',
            role: 'SliceWorker',
            order: 1
          }
        },
        baseRoute
      )

    await runSeat('seat-a')
    // seat-b loads BEFORE it saves — with only seat-a persisted, a leak would
    // surface here.
    await runSeat('seat-b')

    expect(getKeys).toContain('ensemble:seat-a')
    expect(getKeys).toContain('ensemble:seat-b')
    expect(saveKeys).toContain('ensemble:seat-a')
    expect(saveKeys).toContain('ensemble:seat-b')
    // Distinct, non-colliding storage slots — one per seat, separate objects.
    expect(store.has('chat-ollama-1::ensemble:seat-a')).toBe(true)
    expect(store.has('chat-ollama-1::ensemble:seat-b')).toBe(true)
    expect(store.get('chat-ollama-1::ensemble:seat-a')).not.toBe(
      store.get('chat-ollama-1::ensemble:seat-b')
    )
  })

  it('sends a name-specific repair when a native tool call names a nonexistent tool', async () => {
    let chatCalls = 0
    const chatBodies: string[] = []
    const executeTool = vi.fn(async () => ({ ok: true, output: 'should not run' }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'stream-model:latest',
              digest: 'digest-stream',
              details: { family: 'qwen' },
              capabilities: ['tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({ details: { family: 'qwen' }, capabilities: ['tools'] })
      }
      if (String(url).endsWith('/api/chat')) {
        chatCalls += 1
        chatBodies.push(String(init?.body || ''))
        if (chatCalls === 1) {
          // A hallucinated tool name — dropped by normalizeOllamaNativeToolCall.
          return ollamaStreamResponse([
            JSON.stringify({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'search_the_web', arguments: { q: 'weather' } } }]
              }
            }),
            JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 3 })
          ])
        }
        return ollamaStreamResponse([
          JSON.stringify({ message: { role: 'assistant', content: 'Answering directly instead.' } }),
          JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 4 })
        ])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { deps } = makeProviderDeps({ fetchMock, executeTool })

    await runOllamaProvider(deps, stubEvent, basePayload, baseRoute)

    // The invalid call did not execute; the model got a specific repair naming
    // the bad tool + pointing at tool_help.
    expect(executeTool).not.toHaveBeenCalled()
    expect(chatBodies.length).toBeGreaterThanOrEqual(2)
    expect(chatBodies[1]).toContain('search_the_web')
    expect(chatBodies[1]).toContain('tool_help')
  })
})

describe('ollamaSessionMemoryKeyForRun', () => {
  const payload = (participantId?: string): any =>
    participantId === undefined ? {} : { ensembleRun: { participantId } }

  it('returns undefined for a non-ensemble (solo) run', () => {
    expect(ollamaSessionMemoryKeyForRun(payload())).toBeUndefined()
    expect(ollamaSessionMemoryKeyForRun(payload('   '))).toBeUndefined()
  })

  it('keys by a sanitized participant id', () => {
    expect(ollamaSessionMemoryKeyForRun(payload('seat-a'))).toBe('ensemble:seat-a')
    // Non [A-Za-z0-9_-] chars collapse to underscores (path/collision safety).
    expect(ollamaSessionMemoryKeyForRun(payload('seat a/b#1'))).toBe('ensemble:seat_a_b_1')
  })

  it('does not collide two distinct dirty ids onto one key', () => {
    const a = ollamaSessionMemoryKeyForRun(payload('alpha:1'))
    const b = ollamaSessionMemoryKeyForRun(payload('beta:1'))
    expect(a).not.toBe(b)
  })

  it('caps a very long id at 120 chars of sanitized body', () => {
    const key = ollamaSessionMemoryKeyForRun(payload('x'.repeat(500)))
    expect(key).toBe(`ensemble:${'x'.repeat(120)}`)
  })
})

describe('normalizeOllamaBaseUrl', () => {
  it('defaults to the local Ollama service when unset or invalid', () => {
    expect(normalizeOllamaBaseUrl('')).toBe('http://127.0.0.1:11434')
    expect(normalizeOllamaBaseUrl('ftp://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('keeps http/https origins and strips path/query/hash noise', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/api/tags?x=1#models')).toBe(
      'http://localhost:11434'
    )
    expect(normalizeOllamaBaseUrl('https://ollama.local:11434///')).toBe(
      'https://ollama.local:11434'
    )
  })
})

describe('normalizeOllamaModels', () => {
  it('extracts context length from Ollama show metadata variants', () => {
    expect(
      extractOllamaShowContextLength({
        model_info: { 'llama.context_length': 65_536 }
      })
    ).toBe(65_536)
    expect(
      extractOllamaShowContextLength({
        model_info: { qwen3_context_length: '131072' }
      })
    ).toBe(131_072)
    expect(
      extractOllamaShowContextLength({
        parameters: 'temperature 0.2\nnum_ctx 32768\n'
      })
    ).toBe(32_768)
  })

  it('enriches status models with context length from /api/show when /api/tags omits it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              model: 'custom-local:latest',
              details: { family: 'qwen3', parameter_size: '9B' },
              capabilities: ['completion', 'tools']
            }
          ]
        })
      }
      if (String(url).endsWith('/api/show')) {
        return jsonResponse({
          model_info: { 'qwen3.context_length': 98_304 },
          capabilities: ['completion', 'tools']
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const status = await getOllamaStatusSnapshot({
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaDefaultModel: 'custom-local:latest'
    })

    expect(status.models?.[0]?.contextLength).toBe(98_304)
  })

  it('maps common local model ids to human-readable labels', () => {
    expect(humanizeOllamaModelId('qwen3:4b-instruct')).toBe('Qwen 3 (4B Param)')
    expect(humanizeOllamaModelId('qwen3.5:9b')).toBe('Qwen 3.5 (9B Param)')
    expect(humanizeOllamaModelId('qwen3.5:9b-q4_K_M')).toBe('Qwen 3.5 (9B Param)')
    expect(humanizeOllamaModelId('qwen3.6:35b')).toBe('Qwen 3.6 (35B-A3B)')
    expect(humanizeOllamaModelId('gemma4:12b')).toBe('Gemma 4 (12B Param)')
    expect(humanizeOllamaModelId('gemma4:12b-it-q4_K_M')).toBe('Gemma 4 (12B Param)')
    expect(humanizeOllamaModelId('ornith')).toBe('Ornith 1.0 (9B Param)')
    expect(humanizeOllamaModelId('ornith:latest')).toBe('Ornith 1.0 (9B Param)')
    expect(humanizeOllamaModelId('ornith:9b')).toBe('Ornith 1.0 (9B Param)')
    expect(humanizeOllamaModelId('ornith:35b')).toBe('Ornith 1.0 (35B Param)')
    expect(humanizeOllamaModelId('ornith:35b-q4_K_M')).toBe('Ornith 1.0 (35B Param)')
    expect(humanizeOllamaModelId('laguna-xs-2.1:q8_0')).toBe(
      'Laguna XS 2.1 (33B-A3B Q8)'
    )
    expect(humanizeOllamaModelId('gpt-oss')).toBe('GPT OSS (20B Param)')
    expect(humanizeOllamaModelId('gpt-oss:20b')).toBe('GPT OSS (20B Param)')
    expect(humanizeOllamaModelId('gpt-oss:latest')).toBe('GPT OSS (20B Param)')
    expect(humanizeOllamaModelId('minicpm-v4.5:8b')).toBe('MiniCPM-V 4.5 (8B Param)')
    expect(humanizeOllamaModelId('granite4.1:30b')).toBe('Granite 4.1 (30B Param)')
    expect(humanizeOllamaModelId('nemotron3:33b')).toBe(
      'Nemotron 3 Nano Omni (33B Param)'
    )
    expect(humanizeOllamaModelId('llama3.1:8b')).toBe('Llama 3.1 (8B Param)')
    expect(humanizeOllamaModelId('deepseek-r1:8b')).toBe('DeepSeek R1 (8B Param)')
    expect(humanizeOllamaModelId('rnj-1:latest')).toBe('Rnj-1 (8B Param)')
    expect(humanizeOllamaModelId('glm-4.7-flash:q4_K_M')).toBe(
      'GLM-4.7-Flash (30B-A3B Q4)'
    )
    expect(humanizeOllamaModelId('north-mini-code-1.0:q4_K_M')).toBe(
      'North Mini Code 1.0 (30B-A3B Q4)'
    )
    expect(humanizeOllamaModelId('llama3.2:3b')).toBe('Llama 3.2 (3B Param)')
  })

  it('deduplicates models and marks the configured default', () => {
    const models = normalizeOllamaModels(
      {
        models: [
          {
            name: 'qwen3:4b-instruct',
            size: 2_500_000_000,
            digest: 'sha256:qwen',
            details: {
              format: 'gguf',
              family: 'qwen3',
              families: ['qwen3'],
              parameter_size: '4B',
              quantization_level: 'Q4_K_M',
              context_length: 262144,
              embedding_length: 2560
            },
            capabilities: ['completion', 'tools']
          },
          { model: 'qwen3:4b-instruct' },
          { model: 'qwen3.5:9b' },
          { model: 'qwen3.6:35b' },
          { model: 'gemma4:12b' },
          { model: 'ornith:9b' },
          { model: 'ornith:35b' },
          { model: 'gpt-oss:20b' },
          { model: 'minicpm-v4.5:8b' },
          { model: 'granite4.1:3b' },
          { model: 'granite4.1:30b' },
          { model: 'nemotron3:33b' },
          { model: 'llama3.2:3b' }
        ]
      },
      'llama3.2:3b'
    )

    expect(models).toHaveLength(12)
    expect(models[0]).toMatchObject({
      id: 'qwen3:4b-instruct',
      label: 'Qwen 3 (4B Param)',
      description: 'qwen3 · 4B · Q4_K_M · 262,144 ctx',
      sizeBytes: 2_500_000_000,
      digest: 'sha256:qwen',
      format: 'gguf',
      family: 'qwen3',
      families: ['qwen3'],
      contextLength: 262144,
      embeddingLength: 2560,
      parameterSize: '4B',
      quantizationLevel: 'Q4_K_M',
      capabilities: ['completion', 'tools'],
      isDefault: false
    })
    expect(models[1]).toMatchObject({
      id: 'qwen3.5:9b',
      label: 'Qwen 3.5 (9B Param)',
      isDefault: false
    })
    expect(models[2]).toMatchObject({
      id: 'qwen3.6:35b',
      label: 'Qwen 3.6 (35B-A3B)',
      isDefault: false
    })
    expect(models[3]).toMatchObject({
      id: 'gemma4:12b',
      label: 'Gemma 4 (12B Param)',
      isDefault: false
    })
    expect(models[4]).toMatchObject({
      id: 'ornith:9b',
      label: 'Ornith 1.0 (9B Param)',
      isDefault: false
    })
    expect(models[5]).toMatchObject({
      id: 'ornith:35b',
      label: 'Ornith 1.0 (35B Param)',
      isDefault: false
    })
    expect(models[6]).toMatchObject({
      id: 'gpt-oss:20b',
      label: 'GPT OSS (20B Param)',
      isDefault: false
    })
    expect(models[7]).toMatchObject({
      id: 'minicpm-v4.5:8b',
      label: 'MiniCPM-V 4.5 (8B Param)',
      isDefault: false
    })
    expect(models[8]).toMatchObject({
      id: 'granite4.1:3b',
      label: 'Granite 4.1 (3B Param)',
      isDefault: false
    })
    expect(models[9]).toMatchObject({
      id: 'granite4.1:30b',
      label: 'Granite 4.1 (30B Param)',
      isDefault: false
    })
    expect(models[10]).toMatchObject({
      id: 'nemotron3:33b',
      label: 'Nemotron 3 Nano Omni (33B Param)',
      isDefault: false
    })
    expect(models[11]).toMatchObject({
      id: 'llama3.2:3b',
      isDefault: true
    })
  })

  it('treats the bare Ornith tag as the installed 9B model when selecting defaults', () => {
    const models = normalizeOllamaModels(
      { models: [{ model: 'ornith:9b' }, { model: 'ornith:35b' }] },
      'ornith'
    )

    expect(models.find((model) => model.id === 'ornith:9b')?.isDefault).toBe(true)
    expect(models.find((model) => model.id === 'ornith:35b')?.isDefault).toBe(false)
  })

  it('falls back to the first model when no default is configured', () => {
    const models = normalizeOllamaModels({
      models: [{ model: 'qwen3:4b-instruct' }, { model: 'llama3.2:3b' }]
    })

    expect(models[0]?.isDefault).toBe(true)
    expect(models[1]?.isDefault).toBe(false)
  })

  it('marks exact installed GPT-OSS tags as default when configured by alias', () => {
    const models = normalizeOllamaModels(
      { models: [{ model: 'qwen3:4b-instruct' }, { model: 'gpt-oss:latest' }] },
      'gpt-oss'
    )
    expect(models.find((model) => model.id === 'gpt-oss:latest')?.isDefault).toBe(true)
  })
})

describe('parseOllamaMemoryPsOutput', () => {
  it('sums llama-server / Ollama runner RSS samples', () => {
    const sample = parseOllamaMemoryPsOutput(
      [
        '123 250000 /Applications/Ollama.app/Contents/Resources/ollama_llama_server --model qwen',
        '124 100000 /Applications/Ollama.app/Contents/Resources/ollama runner --model other',
        '125 50000 /usr/bin/other-process'
      ].join('\n'),
      '2026-06-08T10:00:00.000Z'
    )

    expect(sample).toMatchObject({
      sampledAt: '2026-06-08T10:00:00.000Z',
      processCount: 2,
      rssBytes: 358_400_000
    })
    expect(sample?.rssGb).toBeCloseTo(0.3584)
  })

  it('returns null when no Ollama model runtime is present', () => {
    expect(parseOllamaMemoryPsOutput('125 50000 /usr/bin/other-process')).toBeNull()
  })
})

describe('parseOllamaToolRequest', () => {
  it('accepts TaskWraith read-only tool requests', () => {
    expect(
      parseOllamaToolRequest(
        '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"gateway"}}}'
      )
    ).toEqual({
      toolName: 'workspace_search',
      arguments: { query: 'gateway' }
    })
  })

  it('rejects hidden canonical names as direct calls', () => {
    expect(
      parseOllamaToolRequest(
        '{"taskwraith_tool":{"name":"web_search","arguments":{"query":"weather"}}}'
      )
    ).toBeNull()
  })

  it('rejects case aliases that were not present in the immutable profile', () => {
    expect(
      parseOllamaToolRequest(
        '{"taskwraith_tool":{"name":"ASkUserQuestion","arguments":{"question":"Continue?"}}}'
      )
    ).toBeNull()
  })

  it('builds a constrained-decoding format schema with the tool-name enum', () => {
    const schema = ollamaToolCallFormatSchema(['read_file', 'write_file', 'tool_help']) as any
    // Envelope is required, name is enum-constrained → the model cannot decode a
    // wrong wrapper key or a hallucinated tool name.
    expect(schema.required).toEqual(['taskwraith_tool'])
    const inner = schema.properties.taskwraith_tool
    expect(inner.required).toEqual(['name'])
    expect(inner.properties.name.enum).toEqual(['read_file', 'write_file', 'tool_help'])
    expect(inner.properties.arguments.type).toBe('object')
    // Empty name list → unconstrained name (no empty enum that rejects everything).
    const open = ollamaToolCallFormatSchema([]) as any
    expect(open.properties.taskwraith_tool.properties.name.enum).toBeUndefined()
  })

  it('accepts the virtual tool_help lookup (not in the catalog)', () => {
    expect(
      parseOllamaToolRequest('{"taskwraith_tool":{"name":"tool_help","arguments":{"name":"git_push"}}}')
    ).toEqual({
      toolName: 'tool_help',
      arguments: { name: 'git_push' }
    })
  })

  it('recovers a tool request whose string args contain invalid JSON escapes', () => {
    // The exact Qwen 3.5 failure: a write_file whose Swift `content` embeds
    // string interpolation `\(date)` — invalid JSON, so strict parse throws and
    // the whole call used to leak to the user as raw text.
    const leaked =
      '{"taskwraith_tool":{"name":"write_file","arguments":{"path":"CambridgeWeather.swift","content":"import Foundation\\nprint(\\"\\(date) sunny\\")\\n","intent":"Create a basic Swift file"}}}'
    const parsed = parseOllamaToolRequest(leaked)
    expect(parsed?.toolName).toBe('write_file')
    expect(parsed?.arguments.path).toBe('CambridgeWeather.swift')
    expect(String(parsed?.arguments.content)).toContain('\\(date)')
    expect(parsed?.arguments.intent).toBe('Create a basic Swift file')
  })

  it('repairs invalid backslash escapes while leaving valid ones intact', () => {
    expect(sanitizeLooseJsonEscapes('"a\\(b)"')).toBe('"a\\\\(b)"')
    // Valid escapes are untouched.
    expect(sanitizeLooseJsonEscapes('"line\\nbreak \\" \\\\ \\u0041"')).toBe(
      '"line\\nbreak \\" \\\\ \\u0041"'
    )
    // `\U` and `\m` are invalid JSON escapes (Windows path) — strict parse
    // fails, the tolerant re-parse recovers the literal backslashes.
    expect(parseJsonObjectLoose('{"x":"C:\\Users\\me"}')).toEqual({ x: 'C:\\Users\\me' })
    expect(parseJsonObjectLoose('{"ok":true}')).toEqual({ ok: true })
  })

  it('extracts fenced JSON for known tools so policy can deny them explicitly', () => {
    expect(
      parseOllamaToolRequest(
        '```json\n{"taskwraith_tool":{"name":"write_file","arguments":{"path":"x","content":"y"}}}\n```'
      )
    ).toEqual({
      toolName: 'write_file',
      arguments: { path: 'x', content: 'y' }
    })
    // Only protocol-critical direct tools are detailed inline. Long-tail tools
    // such as web search are reached through capability discovery or tool_help.
    expect(ollamaLocalToolSystemPrompt()).toContain(
      '- write_file: {"path":"relative/path.txt","content":"...","intent":"short reason before changing files"}'
    )
    expect(ollamaLocalToolSystemPrompt()).not.toContain('web_search')
    expect(ollamaLocalToolSystemPrompt()).not.toContain('web_fetch')
    expect(ollamaLocalToolSystemPrompt()).toContain('tool_help')
  })

  it('requires exact raw identity and the run-pinned available-tool list', () => {
    for (const name of [
      'mcp__evil__read_file',
      'mcp__TaskWraith__read_file',
      'mcp__evil__ensemble_control'
    ]) {
      expect(
        parseOllamaToolRequest(
          JSON.stringify({ taskwraith_tool: { name, arguments: { path: 'README.md' } } })
        ),
        name
      ).toBeNull()
    }
    expect(
      parseOllamaToolRequest(
        '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"gateway"}}}',
        ['read_file', 'tool_help']
      )
    ).toBeNull()
    expect(
      parseOllamaToolRequest(
        '{"taskwraith_tool":{"name":"read_file","arguments":{"path":"README.md"}}}',
        ['read_file', 'tool_help']
      )
    ).toEqual({ toolName: 'read_file', arguments: { path: 'README.md' } })
  })

  it('encourages local models to chain multi-step work after a tool result', () => {
    const followUp = ollamaToolResultFollowUpPrompt({
      toolName: 'read_file',
      output: 'README content',
      ok: true
    })
    expect(followUp).toContain('Continue the task using this result')
    expect(followUp).toContain('call another TaskWraith tool now')
    expect(followUp).toContain('Do not repeat an identical tool call')
    expect(ollamaEmptyToolResponseRetryPrompt()).toContain('Answer the original user now')
    expect(ollamaEmptyResponseRetryPrompt()).toContain('Answer the original user request now')
  })

  it('builds a narrow repair prompt for missing tool arguments', () => {
    const prompt = ollamaToolArgumentRepairPrompt({
      toolName: 'read_file',
      output: 'Your read_file call is missing required argument: path.'
    })
    expect(prompt).toContain('rejected read_file before execution')
    expect(prompt).toContain('Validation error:')
    expect(prompt).toContain('Re-issue the same read_file tool call')
    expect(prompt).not.toContain('The tool failed.')
  })

  it('validates required tool arguments with executor-supported aliases only', () => {
    expect(validateOllamaToolArguments('read_file', { file_path: 'README.md' })).toEqual({
      ok: true
    })
    expect(validateOllamaToolArguments('find_files', { globs: ['*.ts'] })).toEqual({ ok: true })
    expect(validateOllamaToolArguments('workspace_search', { pattern: 'TaskWraith' })).toEqual({
      ok: true
    })
    expect(
      validateOllamaToolArguments('rename_path', {
        from: 'old.txt',
        name: 'new.txt',
        intent: 'rename file'
      })
    ).toEqual({ ok: true })

    const crossToolAlias = validateOllamaToolArguments('read_file', { directory: 'src' })
    expect(crossToolAlias.ok).toBe(false)
    if (!crossToolAlias.ok) expect(crossToolAlias.message).toContain('path')

    const emptyPattern = validateOllamaToolArguments('find_files', { globs: [] })
    expect(emptyPattern.ok).toBe(false)
    if (!emptyPattern.ok) expect(emptyPattern.message).toContain('pattern')

    // `intent` is validated through the executor's own intent gate, so any of
    // intent/summary/reason/description satisfies it — matching the runtime
    // assertOllamaMutationIntent check exactly (no false-positive rejection).
    expect(
      validateOllamaToolArguments('write_file', { path: 'a.ts', content: 'x', reason: 'add file' })
    ).toEqual({ ok: true })
    expect(
      validateOllamaToolArguments('run_shell_command', { command: 'ls', summary: 'list files' })
    ).toEqual({ ok: true })
    const missingIntent = validateOllamaToolArguments('write_file', { path: 'a.ts', content: 'x' })
    expect(missingIntent.ok).toBe(false)
    if (!missingIntent.ok) expect(missingIntent.message).toContain('intent')
  })

  it('voices the retry-ceiling finalize differently for solo vs ensemble runs', () => {
    const solo = ollamaCeilingFinalizeContent()
    expect(solo).toContain('stopping instead of looping')
    expect(solo).toContain('rephrase or narrow the request')
    const ensemble = ollamaCeilingFinalizeContent({ ensembleRun: true })
    expect(ensemble).toContain('deferring to the panel')
    // An ensemble seat must NOT instruct the user — that's the orchestrator's job.
    expect(ensemble).not.toContain('rephrase or narrow the request')
  })

  it('flags a wrong-TYPE load-bearing argument with a repairable message', () => {
    const numPath = validateOllamaToolArguments('write_file', {
      path: 5 as unknown as string,
      content: 'x',
      intent: 'write'
    })
    expect(numPath.ok).toBe(false)
    if (!numPath.ok) {
      expect(numPath.message).toContain('path')
      expect(numPath.message).toContain('string')
    }
    const stringTodos = validateOllamaToolArguments('todo_write', {
      todos: 'do the thing' as unknown as unknown[]
    })
    expect(stringTodos.ok).toBe(false)
    if (!stringTodos.ok) expect(stringTodos.message).toContain('todos')

    // Correct types pass...
    expect(
      validateOllamaToolArguments('write_file', { path: 'a.ts', content: 'x', intent: 'write' })
    ).toEqual({ ok: true })
    // ...and the type check must NOT false-positive find_files' glob LIST (its
    // `pattern` accepts a string OR an array via the `globs` synonym).
    expect(validateOllamaToolArguments('find_files', { globs: ['*.ts'] })).toEqual({ ok: true })
  })

  it('keeps empty-response retry nudges anchored to ensemble assignments', () => {
    expect(ollamaEmptyToolResponseRetryPrompt({ ensembleRun: true })).toContain(
      'assigned ensemble slice'
    )
    expect(ollamaEmptyResponseRetryPrompt({ ensembleRun: true })).toContain(
      'assigned participant role'
    )
    expect(ollamaDegenerateResponseNudgePrompt({ ensembleRun: true })).toContain(
      'assigned slice needs workspace facts'
    )
  })

  it('nudges reasoning-only turns to act instead of leaking chain-of-thought', () => {
    const prompt = ollamaReasoningOnlyNudgePrompt()
    expect(prompt).toContain('internal reasoning but no final answer and no tool call')
    expect(prompt).toContain('call one of the available tools now')
    expect(prompt).toContain('Do not leave your response only in hidden reasoning')
    expect(ollamaReasoningOnlyNudgePrompt({ ensembleRun: true })).toContain(
      'assigned participant role'
    )
  })

  it('keeps web tools in the discoverable tail instead of the direct profile', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only')
    expect(prompt).not.toContain('web_search to find sources')
    expect(prompt).not.toContain('web_fetch a chosen URL')
    expect(prompt).toContain('More TaskWraith tools exist beyond these')
    expect(prompt).toContain('tool_help')
  })

  it('omits live internet copy when the resolved run posture denies network access', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'gpt-oss:latest', {
      networkAccess: 'deny'
    })
    // When the run denies network (global kill switch / preview-risk model), the
    // web tools are stripped from the surface and the web-flow guidance is omitted.
    expect(prompt).not.toContain('web_search to find sources')
    expect(prompt).not.toContain('- web_search:')
    expect(prompt).not.toContain('- web_fetch:')
    expect(prompt).toContain('- read_file:')
  })

  it('tells local models not to announce a tool call without issuing it', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only')
    expect(prompt).toContain('Do NOT announce or describe a tool call in prose')
    expect(prompt).toContain('describing a tool without calling it does nothing')
  })

  it('advertises the tool_help lookup for on-demand tool arguments', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only')
    expect(prompt).toContain('tool_help')
    expect(prompt).toContain(
      '{"taskwraith_tool":{"name":"tool_help","arguments":{"name":"<tool or empty to list>"}}}'
    )
    // Curated taxonomy: the preamble tells the model more tools exist beyond the advertised set.
    expect(prompt).toContain('More TaskWraith tools exist beyond these')
  })

  it('falls back to the thinking channel when content is empty (gpt-oss)', () => {
    expect(resolveOllamaVisibleText({ content: 'final answer', thinking: 'reasoning' })).toBe(
      'final answer'
    )
    expect(resolveOllamaVisibleText({ content: '   ', thinking: 'the weather is sunny' })).toBe(
      'the weather is sunny'
    )
    expect(
      resolveOllamaVisibleText({
        content: '',
        thinking:
          'We need to produce a response as Ollama / Qwen36 (qwen3.6:35b). The prior participants already spoke.'
      })
    ).toBe('')
    expect(resolveOllamaVisibleText({ content: '', thinking: '' })).toBe('')
  })

  it('unwraps GPT-OSS analysis/response JSON envelopes before rendering', () => {
    const envelope = JSON.stringify({
      analysis: 'private planning text',
      response: 'Public final answer.'
    })
    expect(unwrapOllamaStructuredResponseText(envelope)).toBe('Public final answer.')
    expect(resolveOllamaVisibleText({ content: envelope, thinking: '' })).toBe(
      'Public final answer.'
    )
  })

  it('emits only non-tool-call reasoning notes that are not prompt restatements', () => {
    // Thinking alongside a tool call is usually planning/prompt echo noise.
    expect(shouldEmitOllamaReasoning({ content: '', thinking: 'planning the edit' }, 1)).toBe(false)
    // Thinking alongside visible content can still be surfaced when it is not
    // just replaying the prompt/harness.
    expect(shouldEmitOllamaReasoning({ content: 'done', thinking: 'reasoning' }, 0)).toBe(true)
    // Thinking promoted to the visible answer (no content, no tool call) → skip.
    expect(shouldEmitOllamaReasoning({ content: '   ', thinking: 'the answer' }, 0)).toBe(false)
    expect(
      shouldEmitOllamaReasoning(
        { content: 'done', thinking: 'We need to respond as Ollama. The user says fix it.' },
        0
      )
    ).toBe(false)
    // No reasoning text → skip.
    expect(shouldEmitOllamaReasoning({ content: 'done', thinking: '   ' }, 0)).toBe(false)
  })

  it('surfaces clean native pre-tool content without promoting prompt echoes', () => {
    expect(
      ollamaPreToolContentText(
        { content: 'I will inspect the relevant files first.', thinking: 'private plan' },
        true
      )
    ).toBe('I will inspect the relevant files first.')
    expect(
      ollamaPreToolContentText(
        { content: 'Workspace coding task: start by grounding in the repo.', thinking: '' },
        true
      )
    ).toBe('')
    expect(
      ollamaPreToolContentText(
        {
          content: '{"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"x"}}}',
          thinking: ''
        },
        true
      )
    ).toBe('')
    expect(
      ollamaPreToolContentText(
        { content: 'I will inspect the relevant files first.', thinking: '' },
        false
      )
    ).toBe('')
  })

  it('detects prompt and harness restatements in Ollama thinking traces', () => {
    expect(
      looksLikeOllamaPromptRestatement(
        'Workspace coding task: start by grounding in the repo. Use todo_write only if needed.'
      )
    ).toBe(true)
    expect(
      looksLikeOllamaPromptRestatement(
        'We need to respond as Ollama / GPT-OSS #1. The user asked for weather.'
      )
    ).toBe(true)
    expect(
      looksLikeOllamaPromptRestatement(
        'We need to produce a response as Ollama / Qwen36 (qwen3.6:35b). The system says Qwen36 already spoke in this turn-bound round.'
      )
    ).toBe(true)
    expect(looksLikeOllamaPromptRestatement('I found the matching file and can now patch it.')).toBe(
      false
    )
  })

  it('detects tool-intent stubs that announce a tool without calling it', () => {
    const tools = ['web_search', 'web_fetch', 'read_file']
    // The exact gpt-oss symptoms from the bug report.
    expect(looksLikeOllamaToolIntent('We need to use web_search tool.', tools)).toBe(true)
    expect(looksLikeOllamaToolIntent('We need to use the web_search tool.', tools)).toBe(true)
    expect(looksLikeOllamaToolIntent("Let's do web_search.", tools)).toBe(true)
    expect(
      looksLikeOllamaToolIntent(
        'We need to perform a web search for "weather in Cambridge today UK". Use web_search.',
        tools
      )
    ).toBe(true)
    // Generic "tool" mention with an action cue, no specific name.
    expect(looksLikeOllamaToolIntent('I should call a tool to do this.', tools)).toBe(true)
  })

  it('does not misclassify real answers or completed-call summaries', () => {
    const tools = ['web_search', 'web_fetch']
    // Past-tense summary of a completed call (\\buse\\b must not match "used").
    expect(
      looksLikeOllamaToolIntent(
        'I used web_search and the weather in Cambridge today is 14°C with light rain.',
        tools
      )
    ).toBe(false)
    // A substantive answer with no tool mention.
    expect(
      looksLikeOllamaToolIntent('The capital of France is Paris, a city on the Seine.', tools)
    ).toBe(false)
    // Empty content.
    expect(looksLikeOllamaToolIntent('   ', tools)).toBe(false)
    // Long substantive answer that happens to mention a tool is not a stub.
    expect(
      looksLikeOllamaToolIntent(`Here is a detailed plan. ${'x'.repeat(420)} web_search`, tools)
    ).toBe(false)
  })

  it('nudges tool-intent stubs to emit a real call and lists tools', () => {
    const prompt = ollamaToolIntentNudgePrompt(['web_search', 'web_fetch'])
    expect(prompt).toContain('did not actually call one')
    expect(prompt).toContain('emit a real tool call now')
    expect(prompt).toContain('Available tools: web_search, web_fetch.')
    expect(prompt).toContain('give your complete final answer')
    expect(prompt).toContain('to the user')
    const ensemblePrompt = ollamaToolIntentNudgePrompt(['web_search'], { ensembleRun: true })
    expect(ensemblePrompt).toContain('assigned participant role')
    expect(ensemblePrompt).toContain('Boss/Bossman/Lead routing')
    expect(ensemblePrompt).not.toContain('to the user')
  })

  it('detects a leaked tool-protocol blob that should not reach the user', () => {
    expect(
      looksLikeLeakedOllamaToolProtocol(
        '{"taskwraith_tool":{"name":"write_file","arguments":{"path":"x"}}}'
      )
    ).toBe(true)
    // Plain prose / real answers are not leaked protocol.
    expect(looksLikeLeakedOllamaToolProtocol('The weather is sunny today.')).toBe(false)
    expect(looksLikeLeakedOllamaToolProtocol('   ')).toBe(false)
  })

  it('detects degenerate single-token stubs and nudges for a full answer', () => {
    expect(looksLikeDegenerateOllamaStub('The')).toBe(true)
    expect(looksLikeDegenerateOllamaStub('I agree.')).toBe(false)
    expect(isDegenerateOllamaTurn({ content: 'The', thinking: '' }, 'The', 0, 1)).toBe(true)
    expect(
      isDegenerateOllamaTurn(
        { content: '', thinking: 'long reasoning ' + 'x'.repeat(120) },
        'long reasoning ' + 'x'.repeat(120),
        0,
        5
      )
    ).toBe(false)
    expect(isDegenerateOllamaTurn({ content: 'done', thinking: '' }, 'done', 1, 1)).toBe(false)
    const prompt = ollamaDegenerateResponseNudgePrompt()
    expect(prompt).toContain('too short to count as a turn')
    expect(prompt).toContain('Do not stop after a single word')
  })

  it('nudges malformed tool JSON to be re-issued as valid JSON', () => {
    const prompt = ollamaMalformedToolJsonNudgePrompt()
    expect(prompt).toContain('could not be parsed as valid JSON')
    expect(prompt).toContain('escape them correctly')
    expect(prompt).toContain('Do not output the tool request as plain prose')
    const ensemblePrompt = ollamaMalformedToolJsonNudgePrompt({ ensembleRun: true })
    expect(ensemblePrompt).toContain('Boss/Bossman/Lead routing')
    expect(ensemblePrompt).toContain('assigned participant slice')
    expect(ensemblePrompt).toContain('assigned role')
  })
})

describe('ollamaNativeToolDefinitions', () => {
  it('emits a smaller schema in compact ensemble mode', () => {
    const full = JSON.stringify(ollamaNativeToolDefinitions('approved_shell'))
    const compact = JSON.stringify(ollamaNativeToolDefinitions('approved_shell', { compact: true }))
    expect(compact.length).toBeLessThan(full.length)
    expect(compact).not.toContain('maxResults')
  })
  it('exposes the exact fresh gateway-v9 canonical surface plus virtual helpers', () => {
    const defs = ollamaNativeToolDefinitions('read_only')
    const names = defs.map((def) => def.function.name)
    expect(names.slice(0, GATEWAY_V9_MCP_DIRECT_TOOLS.length)).toEqual([
      ...GATEWAY_V9_MCP_DIRECT_TOOLS
    ])
    expect(names.slice(GATEWAY_V9_MCP_DIRECT_TOOLS.length)).toEqual([
      ...CAPABILITY_GATEWAY_TOOL_NAMES,
      'tool_help'
    ])
  })

  it('declares a compact action-plus-params shape for portable Ensemble control', () => {
    const portable = ollamaNativeToolDefinitions('provider_parity').find(
      (definition) => definition.function.name === 'ensemble_control'
    )
    expect(portable?.function.parameters.required).toEqual(['action'])
    expect(portable?.function.parameters.properties).toMatchObject({
      action: { type: 'string' },
      params: { type: 'object' }
    })
  })

  it('omits native web schemas when the resolved run posture denies network access', () => {
    const defs = ollamaNativeToolDefinitions('read_only', { networkAccess: 'deny' })
    const names = defs.map((def) => def.function.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('web_search')
    expect(names).not.toContain('web_fetch')
    expect(names).not.toContain('github_ci_status')
  })

  it('keeps the legacy tier inert and marks direct shell mutation intent required', () => {
    const defs = ollamaNativeToolDefinitions('approved_shell')
    const names = defs.map((def) => def.function.name)
    expect(names).toContain('write_file')
    expect(names).toContain('run_shell_command')
    expect(names).not.toContain('get_diagnostics')
    const shell = defs.find((def) => def.function.name === 'run_shell_command')
    expect(shell?.function.parameters.required).toEqual(['command', 'intent'])
  })
})

describe('normalizeOllamaNativeToolCall', () => {
  it('accepts object arguments for known tools', () => {
    expect(
      normalizeOllamaNativeToolCall({
        function: { name: 'workspace_search', arguments: { query: 'gateway' } }
      })
    ).toEqual({ toolName: 'workspace_search', arguments: { query: 'gateway' } })
  })

  it('parses stringified JSON arguments', () => {
    expect(
      normalizeOllamaNativeToolCall({
        function: { name: 'read_file', arguments: '{"path":"README.md"}' }
      })
    ).toEqual({ toolName: 'read_file', arguments: { path: 'README.md' } })
  })

  it('unwraps the portable Ensemble parameter envelope before dispatch', () => {
    expect(
      normalizeOllamaNativeToolCall({
        function: {
          name: 'ensemble_control',
          arguments: { action: 'set_round_plan', params: { goal: 'Review.' } }
        }
      })
    ).toEqual({
      toolName: 'ensemble_bossman_control',
      arguments: { action: 'set_round_plan', goal: 'Review.' }
    })
  })

  it('rejects hidden canonical native calls', () => {
    expect(
      normalizeOllamaNativeToolCall({
        function: { name: 'web_fetch', arguments: { url: 'https://example.com' } }
      })
    ).toBeNull()
  })

  it('rejects case aliases that were not advertised', () => {
    expect(
      normalizeOllamaNativeToolCall({
        function: { name: 'AskUserQuestion', arguments: { question: 'Continue?' } }
      })
    ).toBeNull()
  })

  it('rejects unknown tool names', () => {
    expect(normalizeOllamaNativeToolCall({ function: { name: 'rm_rf', arguments: {} } })).toBeNull()
  })

  it('rejects foreign namespaces and tools absent from the run-pinned profile', () => {
    for (const name of [
      'mcp__evil__read_file',
      'mcp__TaskWraith__read_file',
      'mcp__evil__ensemble_control'
    ]) {
      expect(
        normalizeOllamaNativeToolCall({ function: { name, arguments: { path: 'README.md' } } }, [
          'read_file',
          'ensemble_control'
        ]),
        name
      ).toBeNull()
    }
    expect(
      normalizeOllamaNativeToolCall(
        { function: { name: 'workspace_search', arguments: { query: 'gateway' } } },
        ['read_file', 'tool_help']
      )
    ).toBeNull()
  })

  it('honors an exact legacy-pinned tool without admitting newer profile names', () => {
    expect(
      normalizeOllamaNativeToolCall(
        {
          function: {
            name: 'ensemble_bossman_control',
            arguments: { action: 'request_status' }
          }
        },
        ['ensemble_bossman_control', 'tool_help']
      )
    ).toEqual({
      toolName: 'ensemble_bossman_control',
      arguments: { action: 'request_status' }
    })
    expect(
      normalizeOllamaNativeToolCall(
        {
          function: {
            name: 'canvas_sketch_open',
            arguments: { title: 'New sketch' }
          }
        },
        ['ensemble_bossman_control', 'tool_help']
      )
    ).toBeNull()
  })
})

describe('Ollama tool surface (tier retired)', () => {
  it('advertises the immutable gateway direct surface for every tier value', () => {
    // Tier retirement (2026-07): the tier arg no longer narrows the surface — the
    // read_only list equals the full provider-parity list, and governance moves to
    // the standard permission role at the approval gate.
    expect(normalizeOllamaToolControlTier('bad-value')).toBe('read_only')
    const readOnly = ollamaToolNamesForTier('read_only')
    expect(readOnly).toEqual(ollamaToolNamesForTier('provider_parity'))
    expect(readOnly).toEqual([...GATEWAY_V9_MCP_DIRECT_TOOLS])
    expect(readOnly).not.toContain('web_search')
    expect(readOnly).not.toContain('git_push')
  })

  it('still marks mutating / remote-git / process-control tools as intent-required', () => {
    // Defense-in-depth survives the tier retirement even though the surface is
    // no longer tier-narrowed.
    expect(ollamaToolRequiresIntent('write_file')).toBe(true)
    expect(ollamaToolRequiresIntent('run_shell_command')).toBe(true)
    expect(ollamaToolRequiresIntent('get_diagnostics')).toBe(true)
    expect(ollamaToolRequiresIntent('git_push')).toBe(true)
    expect(ollamaToolRequiresIntent('cancel_active_run')).toBe(true)
  })

  it('keeps every legacy tier value on the same compact direct profile', () => {
    const tools = ollamaToolNamesForTier('provider_parity')
    expect(tools).toEqual([...GATEWAY_V9_MCP_DIRECT_TOOLS])
    expect(ollamaToolNamesForTier('read_only')).toEqual(tools)
  })
})

describe('Ollama goal lifecycle tools', () => {
  it('stops the local tool loop after successful terminal goal actions', () => {
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_complete', true)).toBe(true)
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_blocked', true)).toBe(true)
    expect(ollamaGoalLifecycleStopContent('goal_complete')).toContain('complete')
    expect(ollamaGoalLifecycleStopContent('goal_blocked')).toContain('blocked')
  })

  it('continues after non-terminal goal tools and failed lifecycle calls', () => {
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_complete', false)).toBe(false)
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_blocked', false)).toBe(false)
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_read', true)).toBe(false)
    expect(shouldStopOllamaAfterGoalLifecycleTool('goal_update', true)).toBe(false)
    expect(shouldStopOllamaAfterGoalLifecycleTool('write_file', true)).toBe(false)
    expect(ollamaGoalLifecycleStopContent('goal_update')).toBeNull()
  })
})

describe('buildOllamaOpeningMessages', () => {
  it('keeps the full harness scaffold for workspace tasks', () => {
    const messages = buildOllamaOpeningMessages({
      toolProtocolEnabled: true,
      harnessEnabled: true,
      promptIntent: 'workspace',
      toolControlTier: 'approved_edits',
      model: 'gpt-oss:latest',
      workspaceIndexBlock: 'Workspace index:\nsrc/',
      userPrompt: 'fix the bug in src/main.ts'
    })

    expect(messages).toHaveLength(3)
    expect(messages[0].role).toBe('system')
    // Prompt economy (2026-07): the standalone "Harness workflow" system line was
    // dropped — the workflow guidance now lives ONLY in the anchored kickoff below.
    expect(messages[0].content).not.toContain('Harness workflow')
    expect(messages[0].content).toContain('Workspace index')
    expect(messages[1]).toEqual({ role: 'user', content: 'fix the bug in src/main.ts' })
    expect(messages[2].role).toBe('user')
    expect(messages[2].content).toContain('todo_write')
    expect(messages[2].content).toContain('grounding in the repo')
    expect(messages[2].content).toContain('previous message')
  })

  it('anchors ensemble harness kickoff to the full ensemble instruction block', () => {
    const messages = buildOllamaOpeningMessages({
      toolProtocolEnabled: true,
      harnessEnabled: true,
      promptIntent: 'workspace',
      toolControlTier: 'approved_edits',
      model: 'ornith:35b',
      workspaceIndexBlock: 'Workspace index:\nsrc/',
      userPrompt: [
        'TaskWraith Ensemble Mode',
        'Role boundary contract:',
        '- Treat Boss routing as authoritative.',
        'Current user request:',
        'Continue the plan arc.'
      ].join('\n'),
      ensembleRun: true
    })

    expect(messages).toHaveLength(3)
    expect(messages[1].content).toContain('TaskWraith Ensemble Mode')
    expect(messages[2].content).toContain('complete TaskWraith Ensemble instruction block')
    expect(messages[2].content).toContain('Boss/Bossman/Lead authority rules')
    expect(messages[2].content).not.toContain('Your task is the user request')
  })

  it('sends only the tool catalog and the user words for conversational turns', () => {
    const messages = buildOllamaOpeningMessages({
      toolProtocolEnabled: true,
      harnessEnabled: true,
      promptIntent: 'conversational',
      toolControlTier: 'approved_edits',
      model: 'gpt-oss:latest',
      workspaceIndexBlock: 'Workspace index:\nsrc/',
      userPrompt: 'Hi OSS how are you?'
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).not.toContain('Harness workflow')
    expect(messages[0].content).not.toContain('Workspace index')
    expect(messages[0].content).toContain('Answer it directly in friendly prose')
    expect(messages[1]).toEqual({ role: 'user', content: 'Hi OSS how are you?' })
  })

  it('sends the bare prompt when the tool protocol is disabled', () => {
    const messages = buildOllamaOpeningMessages({
      toolProtocolEnabled: false,
      harnessEnabled: false,
      promptIntent: 'conversational',
      toolControlTier: 'read_only',
      model: 'gpt-oss:latest',
      workspaceIndexBlock: '',
      userPrompt: 'hello!'
    })

    expect(messages).toEqual([{ role: 'user', content: 'hello!' }])
  })
})

describe('repeated-tool-call guard', () => {
  it('builds an order-independent key for the same arguments', () => {
    expect(ollamaToolCallKey('read_file', { path: 'a.py', start: 1 })).toBe(
      ollamaToolCallKey('read_file', { start: 1, path: 'a.py' })
    )
    expect(ollamaToolCallKey('read_file', { path: 'a.py' })).not.toBe(
      ollamaToolCallKey('read_file', { path: 'b.py' })
    )
  })

  it('signatures differ when content changes, match when identical', () => {
    expect(ollamaToolResultSignature('hello')).toBe(ollamaToolResultSignature('hello'))
    expect(ollamaToolResultSignature('hello')).not.toBe(ollamaToolResultSignature('hello!'))
    // Length prefix guards against length-equal hash collisions.
    expect(ollamaToolResultSignature('')).toBe('0:811c9dc5')
  })

  it('flags a second identical call with an unchanged result', () => {
    const sigs = new Map<string, string>()
    const args = { path: 'test_kimi_datetime.py' }
    expect(evaluateOllamaRepeatedToolCall(sigs, 'read_file', args, 'FILE BODY').repeated).toBe(false)
    expect(evaluateOllamaRepeatedToolCall(sigs, 'read_file', args, 'FILE BODY').repeated).toBe(true)
  })

  it('does NOT flag a re-read after the file changed (e.g. post-edit verify)', () => {
    const sigs = new Map<string, string>()
    const args = { path: 'a.py' }
    expect(evaluateOllamaRepeatedToolCall(sigs, 'read_file', args, 'v1').repeated).toBe(false)
    // File changed → not a no-op repeat; the new body is recorded.
    expect(evaluateOllamaRepeatedToolCall(sigs, 'read_file', args, 'v2').repeated).toBe(false)
    // Re-reading the NEW body without changes is again a repeat.
    expect(evaluateOllamaRepeatedToolCall(sigs, 'read_file', args, 'v2').repeated).toBe(true)
  })

  it('flags non-consecutive repeats (read A, read B, read A again)', () => {
    const sigs = new Map<string, string>()
    evaluateOllamaRepeatedToolCall(sigs, 'read_file', { path: 'a.py' }, 'A')
    evaluateOllamaRepeatedToolCall(sigs, 'read_file', { path: 'b.py' }, 'B')
    expect(
      evaluateOllamaRepeatedToolCall(sigs, 'read_file', { path: 'a.py' }, 'A').repeated
    ).toBe(true)
  })

  it('keys different tools and different args separately', () => {
    const sigs = new Map<string, string>()
    evaluateOllamaRepeatedToolCall(sigs, 'read_file', { path: 'a.py' }, 'same')
    expect(
      evaluateOllamaRepeatedToolCall(sigs, 'search_files', { path: 'a.py' }, 'same').repeated
    ).toBe(false)
    expect(
      evaluateOllamaRepeatedToolCall(sigs, 'read_file', { path: 'b.py' }, 'same').repeated
    ).toBe(false)
  })

  it('nudge names the tool and forbids repeating', () => {
    const nudge = ollamaRepeatedToolCallNudge('read_file')
    expect(nudge).toContain('read_file')
    expect(nudge).toContain('Do NOT call it again')
    const ensembleNudge = ollamaRepeatedToolCallNudge('read_file', { ensembleRun: true })
    expect(ensembleNudge).toContain('assigned ensemble slice')
    expect(ensembleNudge).toContain('Boss/Bossman/Lead routing')
    expect(ensembleNudge).toContain('role owns')
  })

  it('detects and rewrites no-active-goal lifecycle failures for the local model', () => {
    const result = {
      ok: false,
      output:
        '{"ok":false,"tool":"goal_update","error":"No active TaskWraith goal is set for this chat."}'
    }
    expect(isOllamaNoActiveGoalToolResult('goal_update', result)).toBe(true)
    expect(isOllamaNoActiveGoalToolResult('read_file', result)).toBe(false)
    const nudge = ollamaNoActiveGoalToolNudge('goal_update')
    expect(nudge).toContain('Do NOT call update_goal')
    expect(nudge).toContain('not todo lists')
    expect(ollamaNoActiveGoalToolNudge('goal_update', { repeated: true })).toContain(
      'already retried'
    )
    const ensembleNudge = ollamaNoActiveGoalToolNudge('goal_update', { ensembleRun: true })
    expect(ensembleNudge).toContain('assigned ensemble slice')
    expect(ensembleNudge).toContain('Boss/Bossman/Lead routing')
    expect(ensembleNudge).not.toContain('Continue the user request')
  })
})

describe('shouldReleaseOllamaContentDelta — streaming cadence gate', () => {
  const base = {
    jsonToolFallback: false,
    toolProtocolEnabled: false,
    availableToolNames: ['read_file', 'edit_file']
  }

  it('never releases an empty pending buffer', () => {
    expect(
      shouldReleaseOllamaContentDelta({ ...base, content: 'hi', pending: '', streamed: '' })
    ).toBe(false)
  })

  it('never releases while the json/tool fallback is active', () => {
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        jsonToolFallback: true,
        content: 'plain prose here',
        pending: 'plain prose here',
        streamed: ''
      })
    ).toBe(false)
  })

  it('releases immediately in a non-tool turn (no length gate)', () => {
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        content: 'Hello there friend',
        pending: 'Hello there friend',
        streamed: ''
      })
    ).toBe(true)
  })

  it('holds the FIRST exposure in a tool turn until enough prose', () => {
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        toolProtocolEnabled: true,
        content: 'short',
        pending: 'short',
        streamed: ''
      })
    ).toBe(false)
  })

  it('releases the first exposure once it reaches 24 chars of prose', () => {
    const text = 'This is ordinary prose text' // 27 chars, no trailing punctuation
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        toolProtocolEnabled: true,
        content: text,
        pending: text,
        streamed: ''
      })
    ).toBe(true)
  })

  it('releases a short first exposure when it ends a sentence', () => {
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        toolProtocolEnabled: true,
        content: 'Hi.',
        pending: 'Hi.',
        streamed: ''
      })
    ).toBe(true)
  })

  it('still holds a leading tool/JSON stub even past 24 chars (hold-guard intact)', () => {
    const stub = '{"name":"read_file","arguments":{}}'
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        toolProtocolEnabled: true,
        content: stub,
        pending: stub,
        streamed: ''
      })
    ).toBe(false)
  })

  it('FIX: releases per token once prose is already streaming (no re-buffer after a short sentence)', () => {
    // streamed already holds a released short sentence; a 3-char token would
    // previously be re-buffered until total >= 24. It must now release per token.
    expect(
      shouldReleaseOllamaContentDelta({
        ...base,
        toolProtocolEnabled: true,
        content: 'Sure, here you go. Now',
        pending: 'Now',
        streamed: 'Sure, here you go. '
      })
    ).toBe(true)
  })
})
