/**
 * The daemon requests an Ollama run costs, counted by a fake daemon's own
 * request log the way the perf harness's scripted daemon counts them.
 *
 * Every run here repeats what the app does for one Ollama turn: the admission
 * preflight reads the adapter's capability contract (`ensureProviderRunPreflight`
 * in main), the run resolves its launch plan, and the run then emits capability
 * warnings, which read the contract again. An isolated perf run of this shape
 * logged 208 `/api/tags` and 800 `/api/show` requests for 88 model turns.
 *
 * Each test binds its own daemon, and the reuse is cleared after each test, so
 * nothing one test reads can answer another even if the OS reissues a port.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import { resetOllamaDaemonReadReuseForTests } from './OllamaDaemonReadReuse'
import {
  fetchOllamaModelCatalog,
  getOllamaCapabilityContract,
  getOllamaStatusSnapshot,
  runOllamaProvider,
  type OllamaProviderDeps
} from './OllamaProvider'

interface FakeModel {
  name: string
  digest: string
  contextLength: number
}

/** The four tags the perf run's scripted daemon served. */
const PERF_MODELS: readonly FakeModel[] = [
  { name: 'scripted-llama:latest', digest: 'sha-latest-1', contextLength: 32_768 },
  { name: 'scripted-llama:t001', digest: 'sha-t001-1', contextLength: 32_768 },
  { name: 'scripted-llama:t002', digest: 'sha-t002-1', contextLength: 32_768 },
  { name: 'scripted-llama:t003', digest: 'sha-t003-1', contextLength: 32_768 }
]

interface FakeDaemon {
  baseUrl: string
  /** The daemon's own request log, keyed `METHOD /path`. */
  counts(): Record<string, number>
  /** `/api/show` requests the daemon received for one model. */
  showRequestsFor(model: string): number
  setModels(models: readonly FakeModel[]): void
  failShowFor(model: string, failing: boolean): void
  failTags(failing: boolean): void
  /** The first `count` chat requests answer with a tool call instead of prose. */
  answerWithToolCalls(count: number): void
  close(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length)
  })
  response.end(bytes)
}

async function startFakeDaemon(initialModels: readonly FakeModel[]): Promise<FakeDaemon> {
  const counts: Record<string, number> = {}
  const showCounts = new Map<string, number>()
  const failingShows = new Set<string>()
  let models = [...initialModels]
  let tagsFailing = false
  let toolCallTurnsLeft = 0
  let toolCallSequence = 0

  const server = createServer((request, response) => {
    const route = `${request.method} ${new URL(request.url || '/', 'http://127.0.0.1').pathname}`
    counts[route] = (counts[route] || 0) + 1
    void (async () => {
      switch (route) {
        case 'GET /api/tags':
          if (tagsFailing) return sendJson(response, 500, { error: 'tags unavailable' })
          return sendJson(response, 200, {
            models: models.map((model) => ({
              name: model.name,
              model: model.name,
              modified_at: '2026-01-01T00:00:00Z',
              size: 4_000_000_000,
              digest: model.digest,
              details: { format: 'gguf', family: 'llama', parameter_size: '8B' },
              capabilities: ['completion', 'tools']
            }))
          })
        case 'GET /api/status':
          return sendJson(response, 200, { cloud: { disabled: true, source: 'config' } })
        case 'POST /api/me':
          return sendJson(response, 401, { error: 'unauthorized' })
        case 'POST /api/show': {
          const body = await readBody(request)
          const name = String(body.model || body.name || '')
          showCounts.set(name, (showCounts.get(name) || 0) + 1)
          const model = models.find((candidate) => candidate.name === name)
          if (!model) return sendJson(response, 404, { error: `model "${name}" not found` })
          if (failingShows.has(name)) return sendJson(response, 500, { error: 'show failed' })
          return sendJson(response, 200, {
            details: { format: 'gguf', family: 'llama', parameter_size: '8B' },
            model_info: {
              'general.architecture': 'llama',
              'llama.context_length': model.contextLength
            },
            capabilities: ['completion', 'tools']
          })
        }
        case 'POST /api/chat': {
          const body = await readBody(request)
          const toolCall = toolCallTurnsLeft > 0
          if (toolCall) {
            toolCallTurnsLeft -= 1
            toolCallSequence += 1
          }
          const message = toolCall
            ? {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'read_file',
                      arguments: { path: `notes-${toolCallSequence}.md` }
                    }
                  }
                ]
              }
            : { role: 'assistant', content: 'Done.' }
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
          response.write(`${JSON.stringify({ model: body.model, message, done: false })}\n`)
          response.end(
            `${JSON.stringify({
              model: body.model,
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 12,
              eval_count: 3
            })}\n`
          )
          return
        }
        case 'POST /api/generate':
          await readBody(request)
          return sendJson(response, 200, { done: true, done_reason: 'unload' })
        default:
          return sendJson(response, 404, { error: `no route ${route}` })
      }
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) })
      else response.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts: () => ({ ...counts }),
    showRequestsFor: (model) => showCounts.get(model) || 0,
    setModels: (next) => {
      models = [...next]
    },
    failShowFor: (model, failing) => {
      if (failing) failingShows.add(model)
      else failingShows.delete(model)
    },
    failTags: (failing) => {
      tagsFailing = failing
    },
    answerWithToolCalls: (count) => {
      toolCallTurnsLeft = count
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const stubEvent = {
  sender: { send: () => undefined }
} as unknown as Electron.IpcMainInvokeEvent

interface App {
  settings: ReturnType<OllamaProviderDeps['getSettings']>
  contractDeps: Pick<OllamaProviderDeps, 'getSettings' | 'getCloudApiKey'>
  deps: OllamaProviderDeps
  exits: Array<number | null>
  errors: string[]
  /** The context window each run launched with, as the run reported it. */
  contextWindows: Array<{ model: string; tokens: number | null | undefined }>
}

function appFor(
  daemon: FakeDaemon,
  options: { executeTool?: OllamaProviderDeps['executeTool'] } = {}
): App {
  const settings = {
    ollamaBaseUrl: daemon.baseUrl,
    ollamaDefaultModel: 'scripted-llama:latest',
    ollamaModelPreflightAt: {},
    agenticServices: { mcpTools: 'allow' },
    geminiMcpBridgeEnabled: true,
    codexSandboxFallback: 'read-only'
  } as unknown as ReturnType<OllamaProviderDeps['getSettings']>
  const contractDeps = { getSettings: () => settings, getCloudApiKey: () => null }
  const exits: Array<number | null> = []
  const errors: string[] = []
  const contextWindows: App['contextWindows'] = []
  const deps: OllamaProviderDeps = {
    getSettings: () => settings,
    getCloudApiKey: () => null,
    getTotalMemoryBytes: () => 32 * 1024 ** 3,
    recordOllamaModelContextTokens: (model, tokens) => {
      contextWindows.push({ model, tokens })
    },
    sendAgentCompatLine: () => undefined,
    sendAgentCompatError: (_sender, _provider, error) => {
      errors.push(error)
    },
    sendAgentCompatExit: (_sender, _provider, code) => {
      exits.push(code)
    },
    runManager: {
      attachAbortController: () => undefined,
      canAdmitTransport: () => true,
      getClaimedTerminalStatus: () => undefined,
      finish: () => undefined,
      confirmTerminalStatus: () => undefined
    } as unknown as OllamaProviderDeps['runManager'],
    // Main's emitProviderCapabilityWarnings reads the adapter's capability
    // contract, which for Ollama is getOllamaCapabilityContract.
    emitProviderCapabilityWarnings: async (_sender, _provider, workspacePath, approvalMode) => {
      await getOllamaCapabilityContract(contractDeps, { workspacePath, approvalMode })
    },
    ...(options.executeTool ? { executeTool: options.executeTool } : {})
  }
  return { settings, contractDeps, deps, exits, errors, contextWindows }
}

let workspace = ''

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'taskwraith-ollama-budget-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  resetOllamaDaemonReadReuseForTests()
})

/** One Ollama turn as the app runs it: admission preflight, then the run. */
async function runLikeTheApp(app: App, model: string, runId: string): Promise<void> {
  const route: AgentRunRoute = { appRunId: runId, appChatId: `chat-${runId}` }
  const payload: AgentRunPayload = {
    provider: 'ollama',
    scope: 'workspace',
    prompt: 'Summarise the notes.',
    workspace,
    model,
    approvalMode: 'default',
    appRunId: runId,
    appChatId: `chat-${runId}`
  }
  await getOllamaCapabilityContract(app.contractDeps, {
    workspacePath: workspace,
    approvalMode: 'default'
  })
  await runOllamaProvider(app.deps, stubEvent, payload, route)
}

describe('Ollama daemon requests per run', () => {
  let daemon: FakeDaemon

  afterEach(async () => {
    await daemon?.close()
  })

  it('a serial round of twelve runs reads the model list once per run and each model once', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    const tags = ['t001', 't002', 't003']

    for (let index = 0; index < 12; index += 1) {
      await runLikeTheApp(app, `scripted-llama:${tags[index % 3]}`, `run-serial-${index}`)
    }

    expect(app.errors).toEqual([])
    expect(app.exits).toEqual(Array.from({ length: 12 }, () => 0))
    expect(daemon.counts()).toEqual({
      'GET /api/tags': 12,
      'GET /api/status': 12,
      'POST /api/me': 12,
      'GET /api/experimental/model-recommendations': 12,
      'POST /api/show': 3,
      'POST /api/chat': 12
    })
  })

  it('six concurrent runs of one model make one /api/show request, not six', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        runLikeTheApp(app, 'scripted-llama:t001', `run-concurrent-${index}`)
      )
    )

    expect(app.errors).toEqual([])
    expect(app.exits).toEqual(Array.from({ length: 6 }, () => 0))
    expect(daemon.counts()).toEqual({
      'GET /api/tags': 1,
      'GET /api/status': 1,
      'POST /api/me': 1,
      'GET /api/experimental/model-recommendations': 1,
      'POST /api/show': 1,
      'POST /api/chat': 6
    })
  })

  it('a run of four model turns makes at most one /api/show request', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon, {
      executeTool: async () => ({ ok: true, output: 'The notes say the build is green.' })
    })
    daemon.answerWithToolCalls(3)

    await runLikeTheApp(app, 'scripted-llama:t001', 'run-turns')

    expect(app.errors).toEqual([])
    expect(app.exits).toEqual([0])
    // Precondition: the run really took four model turns.
    expect(daemon.counts()['POST /api/chat']).toBe(4)
    expect(daemon.counts()['POST /api/show']).toBeLessThanOrEqual(1)
  })

  it('an explicit refresh reaches the daemon, and the next run uses what it found', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-before-pull')
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: 32_768 })

    // In a terminal the user re-pulls t001, whose new build has a wider window,
    // and pulls t004. Then they press Refresh in Settings → Providers → Ollama,
    // which reads the contract, the model list and the status together.
    daemon.setModels([
      ...PERF_MODELS.filter((model) => model.name !== 'scripted-llama:t001'),
      { name: 'scripted-llama:t001', digest: 'sha-t001-2', contextLength: 131_072 },
      { name: 'scripted-llama:t004', digest: 'sha-t004-1', contextLength: 8_192 }
    ])
    const before = daemon.counts()
    const [contract, catalog, status] = await Promise.all([
      getOllamaCapabilityContract(app.contractDeps, {
        workspacePath: workspace,
        approvalMode: 'default'
      }),
      fetchOllamaModelCatalog(app.settings, { cloudApiKey: null }),
      getOllamaStatusSnapshot(app.settings, { cloudApiKey: null })
    ])
    const after = daemon.counts()

    expect(contract.availability.available).toBe(true)
    expect(after['GET /api/tags']).toBeGreaterThan(before['GET /api/tags'])
    expect(after['POST /api/show'] - before['POST /api/show']).toBeGreaterThanOrEqual(5)
    const statusModels = status.models ?? []
    expect(catalog.models.map((model) => model.id)).toContain('scripted-llama:t004')
    expect(statusModels.map((model) => model.id)).toContain('scripted-llama:t004')
    expect(statusModels.find((model) => model.id === 'scripted-llama:t001')?.contextLength).toBe(
      131_072
    )

    await runLikeTheApp(app, 'scripted-llama:t001', 'run-after-refresh')

    expect(app.exits).toEqual([0, 0])
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: 131_072 })
  })

  it('a failed /api/show is not cached: the next run asks again and gets the window', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    daemon.failShowFor('scripted-llama:t001', true)

    await runLikeTheApp(app, 'scripted-llama:t001', 'run-show-failing')

    // The run goes ahead without the daemon's metadata.
    expect(app.exits).toEqual([0])
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: undefined })
    const failedRequests = daemon.showRequestsFor('scripted-llama:t001')
    expect(failedRequests).toBeGreaterThan(0)

    daemon.failShowFor('scripted-llama:t001', false)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-show-healthy')

    expect(app.exits).toEqual([0, 0])
    expect(daemon.showRequestsFor('scripted-llama:t001')).toBeGreaterThan(failedRequests)
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: 32_768 })
  })

  it('a model re-pulled between two runs is read again without any refresh', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-before-pull')

    daemon.setModels(
      PERF_MODELS.map((model) =>
        model.name === 'scripted-llama:t001'
          ? { ...model, digest: 'sha-t001-2', contextLength: 131_072 }
          : model
      )
    )
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-after-pull')

    expect(app.exits).toEqual([0, 0])
    expect(app.contextWindows.map((entry) => entry.tokens)).toEqual([32_768, 131_072])
  })

  it('a refresh replaces the show metadata runs reuse even when the digest is unchanged', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-before-refresh')
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: 32_768 })

    // A daemon whose tag keeps its digest while its metadata changes, such as
    // a Cloud row the daemon proxies: only the Refresh can tell the app.
    daemon.setModels(
      PERF_MODELS.map((model) =>
        model.name === 'scripted-llama:t001' ? { ...model, contextLength: 65_536 } : model
      )
    )
    await getOllamaStatusSnapshot(app.settings, { cloudApiKey: null })
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-after-refresh')

    expect(app.exits).toEqual([0, 0])
    expect(app.contextWindows.at(-1)).toEqual({ model: 'scripted-llama:t001', tokens: 65_536 })
  })

  it('a failed model-list read is not cached, and runs stop reusing the list it replaced', async () => {
    daemon = await startFakeDaemon(PERF_MODELS)
    const app = appFor(daemon)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-tags-healthy')
    expect(app.exits).toEqual([0])

    daemon.failTags(true)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-tags-failing')

    expect(app.exits).toHaveLength(2)
    expect(app.exits[1]).not.toBe(0)
    const failedReads = daemon.counts()['GET /api/tags']

    daemon.failTags(false)
    await runLikeTheApp(app, 'scripted-llama:t001', 'run-tags-recovered')

    expect(app.exits.at(-1)).toBe(0)
    expect(daemon.counts()['GET /api/tags']).toBeGreaterThan(failedReads)
  })
})
