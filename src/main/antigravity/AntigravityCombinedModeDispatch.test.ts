import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  ANTIGRAVITY_COMBINED_MODE_PROVIDER,
  dispatchAntigravityCombinedMode,
  isAntigravityGeminiApiModelCandidate,
  type AntigravityCombinedModeDispatchDependencies
} from './AntigravityCombinedModeDispatch'
import { mapAntigravityGeminiApiTurnStatusToMessage } from './AntigravityGeminiApiMainRuntime'

const VALID_MODEL = 'gemini-api:gemini-2.5-flash'
const PROMPT = 'Hello from S4b'
const RUN_ID = 'run-exact-1'
const CHAT_ID = 'chat-exact-1'
const SETTINGS = { antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_000 }
const SENTINEL = 'sentinel-untrusted-dispatch-leak'
const API_KEY = 'AIza-explicit-user-supplied-test-key'

type Capture = {
  agyCalls: AgentRunPayload[]
  lines: unknown[]
  errors: string[]
  exits: Array<number | null>
  finishes: Array<{ runId: string | undefined; status: string }>
  attached: Array<{ runId: string; controller: AbortController }>
  secretLoads: number
  mainTurnCalls: Array<{
    model: string
    prompt: string
    route: { appChatId?: string; appRunId?: string }
  }>
}

function basePayload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'antigravity',
    scope: 'workspace',
    workspace: '/tmp/workspace',
    prompt: PROMPT,
    model: VALID_MODEL,
    appRunId: RUN_ID,
    appChatId: CHAT_ID,
    ...overrides
  }
}

function mockEvent(): Electron.IpcMainInvokeEvent {
  return { sender: { id: 7 } as Electron.WebContents } as Electron.IpcMainInvokeEvent
}

function createDeps(
  overrides: Partial<AntigravityCombinedModeDispatchDependencies> & {
    sessions?: Map<string, { provider: 'antigravity'; status: 'starting' | 'running' | 'failed' }>
  } = {}
): { deps: AntigravityCombinedModeDispatchDependencies; capture: Capture } {
  const capture: Capture = {
    agyCalls: [],
    lines: [],
    errors: [],
    exits: [],
    finishes: [],
    attached: [],
    secretLoads: 0,
    mainTurnCalls: []
  }
  const sessions =
    overrides.sessions ??
    new Map([[RUN_ID, { provider: 'antigravity' as const, status: 'starting' as const }]])

  const deps: AntigravityCombinedModeDispatchDependencies = {
    getSettings: () => SETTINGS,
    getSecretStore: () => ({
      loadApiKey: () => {
        capture.secretLoads += 1
        return { status: 'ok' as const, value: API_KEY }
      }
    }),
    getRunSession: (runId) => sessions.get(runId),
    attachAbortController: (runId, controller) => {
      capture.attached.push({ runId, controller })
    },
    sendAgentCompatLine: (_sender, _provider, payload) => {
      capture.lines.push(payload)
    },
    sendAgentCompatError: (_sender, _provider, message) => {
      capture.errors.push(message)
    },
    sendAgentCompatExit: (_sender, _provider, code) => {
      capture.exits.push(code)
    },
    finishRun: (runId, status) => {
      capture.finishes.push({ runId, status })
    },
    runAgyProvider: async (_event, payload) => {
      capture.agyCalls.push(payload)
    },
    runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
      capture.mainTurnCalls.push({
        model: request.model,
        prompt: request.prompt,
        route: { ...request.route }
      })
      turnDeps.attachAbortController?.(request.route.appRunId, new AbortController())
      turnDeps.emitInit({
        type: 'init',
        session_id: request.route.appChatId || request.route.appRunId || '',
        model: request.model,
        timestamp: new Date(0).toISOString(),
        provider: 'antigravity',
        runtime: 'gemini-api',
        fallback: false
      })
      turnDeps.emitContent({
        type: 'content',
        text: 'ok',
        provider: 'antigravity',
        runtime: 'gemini-api'
      })
      turnDeps.emitResult({
        type: 'result',
        status: 'success',
        stats: {},
        provider: 'antigravity',
        runtime: 'gemini-api',
        providerThreadId: request.route.appChatId || request.route.appRunId || '',
        fallback: false
      })
      turnDeps.emitExit(0)
      turnDeps.finishRun('completed')
    },
    ...overrides
  }

  return { deps, capture }
}

describe('isAntigravityGeminiApiModelCandidate', () => {
  it('admits exact valid gemini-api:gemini-* routes', () => {
    expect(isAntigravityGeminiApiModelCandidate(VALID_MODEL)).toBe(true)
  })

  it('quarantines malformed, whitespace, and case-variant namespace candidates', () => {
    expect(isAntigravityGeminiApiModelCandidate('gemini-api:claude-3')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api:gemini 2.5 flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate(' Gemini-API:gemini-2.5-flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api :gemini-2.5-flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('GEMINI-API:gemini-2.5-flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('\tgemini-api:gemini-2.5-flash\n')).toBe(true)
    // Colonless / space-delimited variants must also quarantine (never reach agy).
    expect(isAntigravityGeminiApiModelCandidate('gemini-api')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('GEMINI-API')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api gemini-2.5-flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('  GEMINI-API  ')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api\tgpt')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api/gemini-2.5-flash')).toBe(true)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api.gemini-2.5-flash')).toBe(true)
  })

  it('leaves ordinary non-API models and alphanumeric/hyphen continuations on the agy lane', () => {
    expect(isAntigravityGeminiApiModelCandidate('gemini-2.5-flash')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('claude-sonnet-4')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('cli-default')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate(undefined)).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate(null)).toBe(false)
    // Token-boundary: alphanumeric or hyphen continuation must NOT quarantine.
    expect(isAntigravityGeminiApiModelCandidate('gemini-apix')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api2')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('gemini-api-extra')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('GEMINI-APIX')).toBe(false)
    expect(isAntigravityGeminiApiModelCandidate('  gemini-apix  ')).toBe(false)
  })
})

describe('dispatchAntigravityCombinedMode', () => {
  it('routes exact valid API models to the Gemini API lifecycle adapter', async () => {
    const { deps, capture } = createDeps()
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(capture.agyCalls).toEqual([])
    expect(capture.mainTurnCalls).toEqual([
      {
        model: VALID_MODEL,
        prompt: PROMPT,
        route: { appRunId: RUN_ID, appChatId: CHAT_ID }
      }
    ])
    expect(capture.attached).toHaveLength(1)
    expect(capture.attached[0]?.runId).toBe(RUN_ID)
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'completed' }])
    expect(capture.exits).toEqual([0])
    expect(capture.secretLoads).toBe(0)
  })

  it('quarantines malformed namespace candidates on the API lane and never falls through to agy', async () => {
    const malformed = [
      'gemini-api:claude-3',
      ' Gemini-API:gemini-2.5-flash',
      'gemini-api :bad',
      'GEMINI-API:gemini-2.5-flash',
      'gemini-api',
      'GEMINI-API',
      'gemini-api gemini-2.5-flash',
      '  gemini-api  '
    ]
    for (const model of malformed) {
      const { deps, capture } = createDeps({
        runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
          capture.mainTurnCalls.push({
            model: request.model,
            prompt: request.prompt,
            route: { ...request.route }
          })
          // Simulate kernel route-before-key-load rejection for malformed models.
          expect(request.model).toBe(model)
          turnDeps.emitError(mapAntigravityGeminiApiTurnStatusToMessage('invalidModel'))
          turnDeps.emitExit(1)
          turnDeps.finishRun('failed')
        }
      })
      await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model }), deps)
      expect(capture.agyCalls).toEqual([])
      expect(capture.mainTurnCalls[0]?.model).toBe(model)
      expect(capture.secretLoads).toBe(0)
    }
  })

  it('preserves ordinary non-API models on the exact agy path byte-for-byte', async () => {
    const payload = basePayload({ model: 'claude-sonnet-4' })
    const { deps, capture } = createDeps()
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)

    expect(capture.mainTurnCalls).toEqual([])
    expect(capture.agyCalls).toHaveLength(1)
    expect(capture.agyCalls[0]).toBe(payload)
    expect(capture.agyCalls[0]?.model).toBe('claude-sonnet-4')
    expect(capture.secretLoads).toBe(0)
    expect(capture.attached).toEqual([])
  })

  it('keeps alphanumeric/hyphen gemini-api continuations on unchanged agy (token boundary)', async () => {
    for (const model of ['gemini-apix', 'gemini-api2', 'gemini-api-extra', 'GEMINI-APIX']) {
      const payload = basePayload({ model })
      const { deps, capture } = createDeps()
      await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)
      expect(capture.mainTurnCalls).toEqual([])
      expect(capture.agyCalls).toHaveLength(1)
      expect(capture.agyCalls[0]).toBe(payload)
      expect(capture.agyCalls[0]?.model).toBe(model)
      expect(capture.secretLoads).toBe(0)
    }
  })

  it('preserves incoming appChatId/appRunId exactly and never synthesizes IDs', async () => {
    const weirdChat = 'chat with spaces\tand\nnewlines'
    const weirdRun = 'run/exact:id+bytes'
    const { deps, capture } = createDeps({
      sessions: new Map([[weirdRun, { provider: 'antigravity', status: 'running' }]])
    })
    await dispatchAntigravityCombinedMode(
      mockEvent(),
      basePayload({ appChatId: weirdChat, appRunId: weirdRun }),
      deps
    )

    expect(capture.mainTurnCalls[0]?.route).toEqual({
      appChatId: weirdChat,
      appRunId: weirdRun
    })
    expect(capture.attached[0]?.runId).toBe(weirdRun)
    expect(JSON.stringify(capture)).not.toMatch(/antigravity-\d|ephemeral|gemini-api-turn:\/\//)
  })

  it('does not call routeWithRunId or invent identities when route fields are absent', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
        capture.mainTurnCalls.push({
          model: request.model,
          prompt: request.prompt,
          route: { ...request.route }
        })
        // Adapter fail-closed path for missing identity.
        turnDeps.emitError(mapAntigravityGeminiApiTurnStatusToMessage('unavailable'))
        turnDeps.emitExit(1)
        turnDeps.finishRun('failed')
      }
    })
    const payload = basePayload()
    delete payload.appRunId
    delete payload.appChatId
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)

    expect(capture.mainTurnCalls[0]?.route).toEqual({})
    expect(capture.agyCalls).toEqual([])
    expect(JSON.stringify(capture.mainTurnCalls)).not.toMatch(/antigravity-/)
  })

  it('fails closed when the dedicated secret store is not post-ready', async () => {
    const { deps, capture } = createDeps({
      getSecretStore: () => null,
      runGeminiApiMainTurn: async () => {
        throw new Error('main turn must not run without a post-ready store')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(capture.agyCalls).toEqual([])
    expect(capture.mainTurnCalls).toEqual([])
    expect(capture.secretLoads).toBe(0)
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('keyUnavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
  })

  it('guards a throwing getSecretStore into fixed nonsecret terminal without rejection or agy fallback', async () => {
    const storeSentinel = 'sentinel-store-throw'
    const { deps, capture } = createDeps({
      getSecretStore: () => {
        throw new Error(storeSentinel)
      },
      runGeminiApiMainTurn: async () => {
        throw new Error('main turn must not run when getSecretStore throws')
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(capture.agyCalls).toEqual([])
    expect(capture.mainTurnCalls).toEqual([])
    expect(capture.secretLoads).toBe(0)
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(JSON.stringify(capture)).not.toContain(storeSentinel)
    expect(JSON.stringify(capture)).not.toContain(API_KEY)
  })

  it('recovers finish exactly once when adapter rejects after exit only', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.emitExit(1)
        throw new Error(SENTINEL)
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(capture.agyCalls).toEqual([])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.errors).toEqual([])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
  })

  it('recovers exit exactly once when adapter rejects after finish only', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.finishRun('failed')
        throw new Error(SENTINEL)
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(capture.agyCalls).toEqual([])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.errors).toEqual([])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
  })

  it('does not re-invoke exit or finish when both already completed before adapter rejection', async () => {
    let exitCalls = 0
    let finishCalls = 0
    const { deps, capture } = createDeps({
      sendAgentCompatExit: (_sender, _provider, code) => {
        exitCalls += 1
        capture.exits.push(code)
      },
      finishRun: (runId, status) => {
        finishCalls += 1
        capture.finishes.push({ runId, status })
      },
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.emitExit(1)
        turnDeps.finishRun('failed')
        throw new Error(SENTINEL)
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(exitCalls).toBe(1)
    expect(finishCalls).toBe(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.errors).toEqual([])
  })

  it('never retries exit after exit side-effect-then-throw; recovers finish once', async () => {
    let exitCalls = 0
    let finishCalls = 0
    const { deps, capture } = createDeps({
      sendAgentCompatExit: (_sender, _provider, code) => {
        exitCalls += 1
        capture.exits.push(code)
        throw new Error(SENTINEL)
      },
      finishRun: (runId, status) => {
        finishCalls += 1
        capture.finishes.push({ runId, status })
      },
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.emitExit(1)
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(exitCalls).toBe(1)
    expect(finishCalls).toBe(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.agyCalls).toEqual([])
    expect(capture.errors).toEqual([])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
    expect(JSON.stringify(capture)).not.toContain(API_KEY)
  })

  it('never retries finish after finish side-effect-then-throw; recovers exit once', async () => {
    let exitCalls = 0
    let finishCalls = 0
    const { deps, capture } = createDeps({
      sendAgentCompatExit: (_sender, _provider, code) => {
        exitCalls += 1
        capture.exits.push(code)
      },
      finishRun: (runId, status) => {
        finishCalls += 1
        capture.finishes.push({ runId, status })
        throw new Error(SENTINEL)
      },
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.finishRun('failed')
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(exitCalls).toBe(1)
    expect(finishCalls).toBe(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.agyCalls).toEqual([])
    expect(capture.errors).toEqual([])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
    expect(JSON.stringify(capture)).not.toContain(API_KEY)
  })

  it('does not double-invoke either projection when both side-effect-then-throw', async () => {
    let exitCalls = 0
    let finishCalls = 0
    const { deps, capture } = createDeps({
      sendAgentCompatExit: (_sender, _provider, code) => {
        exitCalls += 1
        capture.exits.push(code)
        throw new Error(`${SENTINEL}-exit`)
      },
      finishRun: (runId, status) => {
        finishCalls += 1
        capture.finishes.push({ runId, status })
        throw new Error(`${SENTINEL}-finish`)
      },
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        try {
          turnDeps.emitExit(1)
        } catch {
          // Adapter continues to finish even if exit callback threw.
        }
        turnDeps.finishRun('failed')
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(exitCalls).toBe(1)
    expect(finishCalls).toBe(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.agyCalls).toEqual([])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
  })

  it('requires an exact existing antigravity RunManager session before abort attachment', async () => {
    const { deps, capture } = createDeps({
      sessions: new Map(),
      runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
        capture.mainTurnCalls.push({
          model: request.model,
          prompt: request.prompt,
          route: { ...request.route }
        })
        try {
          turnDeps.attachAbortController?.(request.route.appRunId, new AbortController())
          throw new Error('attach must fail closed without a live session')
        } catch {
          turnDeps.emitError(mapAntigravityGeminiApiTurnStatusToMessage('unavailable'))
          turnDeps.emitResult({
            type: 'result',
            status: 'failed',
            stats: { duration_ms: 0 },
            provider: 'antigravity',
            runtime: 'gemini-api',
            providerThreadId: request.route.appChatId || '',
            fallback: false
          })
          turnDeps.emitExit(1)
          turnDeps.finishRun('failed')
        }
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(capture.agyCalls).toEqual([])
    expect(capture.attached).toEqual([])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.exits).toEqual([1])
  })

  it('rejects non-antigravity or terminal sessions at abort attachment', async () => {
    for (const session of [
      { provider: 'claude' as const, status: 'running' as const },
      { provider: 'antigravity' as const, status: 'failed' as const }
    ]) {
      const { deps, capture } = createDeps({
        sessions: new Map([[RUN_ID, session as { provider: 'antigravity'; status: 'failed' }]]),
        getRunSession: () => session as never,
        runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
          try {
            turnDeps.attachAbortController?.(request.route.appRunId, new AbortController())
            throw new Error('expected session gate failure')
          } catch {
            turnDeps.emitError(mapAntigravityGeminiApiTurnStatusToMessage('unavailable'))
            turnDeps.emitExit(1)
            turnDeps.finishRun('failed')
          }
        }
      })
      await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
      expect(capture.attached).toEqual([])
      expect(capture.agyCalls).toEqual([])
      expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    }
  })

  it('wires the exact AbortController for cancellation without double terminalization', async () => {
    let attached: AbortController | undefined
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
        const controller = new AbortController()
        turnDeps.attachAbortController?.(request.route.appRunId, controller)
        attached = controller
        turnDeps.emitInit({
          type: 'init',
          session_id: CHAT_ID,
          model: request.model,
          timestamp: new Date(0).toISOString(),
          provider: 'antigravity',
          runtime: 'gemini-api',
          fallback: false
        })
        controller.abort()
        turnDeps.emitExit(130)
        turnDeps.finishRun('cancelled')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(attached?.signal.aborted).toBe(true)
    expect(capture.attached).toHaveLength(1)
    expect(capture.attached[0]?.controller).toBe(attached)
    expect(capture.exits).toEqual([130])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'cancelled' }])
  })

  it('absorbs adapter rejection into a single fixed failed terminal without agy fallback', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async () => {
        throw new Error(SENTINEL)
      }
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()

    expect(capture.agyCalls).toEqual([])
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(JSON.stringify(capture)).not.toContain(SENTINEL)
    expect(JSON.stringify(capture)).not.toContain(API_KEY)
  })

  it('does not double-terminalize when the adapter already owned exit/finish', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiMainTurn: async (_settings, _request, turnDeps) => {
        turnDeps.emitExit(1)
        turnDeps.finishRun('failed')
        throw new Error(SENTINEL)
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.errors).toEqual([])
  })

  it('survives throwing compat callbacks without rejecting or falling through to agy', async () => {
    const { deps, capture } = createDeps({
      sendAgentCompatLine: () => {
        throw new Error(SENTINEL)
      },
      sendAgentCompatError: () => {
        throw new Error(SENTINEL)
      },
      sendAgentCompatExit: () => {
        throw new Error(SENTINEL)
      },
      finishRun: (runId, status) => {
        capture.finishes.push({ runId, status })
      },
      getSecretStore: () => null
    })
    await expect(
      dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    ).resolves.toBeUndefined()
    expect(capture.agyCalls).toEqual([])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
  })

  it('never loads secrets in the bridge itself before kernel validation', async () => {
    let loadDuringDispatch = 0
    const { deps, capture } = createDeps({
      getSecretStore: () => ({
        loadApiKey: () => {
          loadDuringDispatch += 1
          return { status: 'ok' as const, value: API_KEY }
        }
      }),
      runGeminiApiMainTurn: async (_settings, request, turnDeps) => {
        // Prove the bridge handed the store through without preloading.
        expect(loadDuringDispatch).toBe(0)
        capture.mainTurnCalls.push({
          model: request.model,
          prompt: request.prompt,
          route: { ...request.route }
        })
        turnDeps.attachAbortController?.(request.route.appRunId, new AbortController())
        turnDeps.emitExit(0)
        turnDeps.finishRun('completed')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    expect(loadDuringDispatch).toBe(0)
    expect(capture.agyCalls).toEqual([])
  })

  it('exports the antigravity provider label for compat projections', () => {
    expect(ANTIGRAVITY_COMBINED_MODE_PROVIDER).toBe('antigravity')
  })
})

describe('AntigravityCombinedModeDispatch source boundaries', () => {
  it('does not import retired gemini, GeminiApiProvider, or routeWithRunId', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./AntigravityCombinedModeDispatch.ts', import.meta.url), 'utf8')
    )
    expect(source).not.toContain('GeminiApiProvider')
    expect(source).not.toContain('tryRunGeminiApi')
    expect(source).not.toContain('routeWithRunId')
    expect(source).not.toContain('createFallbackRunId')
    expect(source).not.toContain("from '../GeminiApiProvider'")
    expect(source).not.toContain("provider: 'gemini'")
    expect(source).not.toContain('AntigravityCli')
  })
})
