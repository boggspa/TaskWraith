import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  ANTIGRAVITY_ACP_LANE_NOT_CONNECTED_MESSAGE,
  ANTIGRAVITY_ACP_TRANSPORT_DISABLED_MESSAGE,
  ANTIGRAVITY_ACP_TURN_UNAVAILABLE_MESSAGE,
  dispatchAntigravityCombinedMode,
  isAntigravityAcpModelCandidate,
  isAntigravityGeminiApiModelCandidate,
  type AntigravityCombinedModeDispatchDependencies
} from './AntigravityCombinedModeDispatch'
import { mapAntigravityGeminiApiTurnStatusToMessage } from './AntigravityGeminiApiMainRuntime'

const VALID_MODEL = 'gemini-api:gemini-2.5-flash'
const RUN_ID = 'run-1'
const CHAT_ID = 'chat-1'
const PROMPT = 'Summarize the diff.'

type Capture = {
  agyCalls: AgentRunPayload[]
  agentTurnCalls: Array<{
    payload: AgentRunPayload
    route: { appChatId?: string; appRunId?: string }
  }>
  errors: string[]
  exits: Array<number | null>
  finishes: Array<{ runId: string | undefined; status: string }>
  terminalOrder: string[]
  sessionRegistrations: Array<{ appChatId?: string; appRunId?: string }>
}

function basePayload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'antigravity',
    scope: 'workspace',
    prompt: PROMPT,
    model: VALID_MODEL,
    appRunId: RUN_ID,
    appChatId: CHAT_ID,
    ...overrides
  } as AgentRunPayload
}

function mockEvent(): Electron.IpcMainInvokeEvent {
  return { sender: { id: 7 } as Electron.WebContents } as Electron.IpcMainInvokeEvent
}

function createDeps(overrides: Partial<AntigravityCombinedModeDispatchDependencies> = {}): {
  deps: AntigravityCombinedModeDispatchDependencies
  capture: Capture
} {
  const capture: Capture = {
    agyCalls: [],
    agentTurnCalls: [],
    errors: [],
    exits: [],
    finishes: [],
    terminalOrder: [],
    sessionRegistrations: []
  }

  const deps: AntigravityCombinedModeDispatchDependencies = {
    registerRunSession: (route) => {
      capture.sessionRegistrations.push({ ...route })
      return { provider: 'antigravity', status: 'starting' }
    },
    runGeminiApiAgentTurn: async (_event, payload, route) => {
      capture.agentTurnCalls.push({ payload, route: { ...route } })
    },
    sendAgentCompatError: (_sender, _provider, message) => {
      capture.terminalOrder.push('error')
      capture.errors.push(message)
    },
    sendAgentCompatExit: (_sender, _provider, code) => {
      capture.terminalOrder.push('exit')
      capture.exits.push(code)
    },
    finishRun: (runId, status) => {
      capture.terminalOrder.push('finish')
      capture.finishes.push({ runId, status })
    },
    runAgyProvider: async (_event, payload) => {
      capture.agyCalls.push(payload)
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
  })
})

describe('dispatchAntigravityCombinedMode', () => {
  it('routes exact valid API models to the agentic Gemini API turn', async () => {
    const { deps, capture } = createDeps()
    const payload = basePayload()
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)

    expect(capture.agyCalls).toEqual([])
    expect(capture.agentTurnCalls).toHaveLength(1)
    expect(capture.agentTurnCalls[0]?.payload).toBe(payload)
    expect(capture.agentTurnCalls[0]?.route).toEqual({ appRunId: RUN_ID, appChatId: CHAT_ID })
    // Dispatch adds no terminal projections of its own on the happy path —
    // the agent turn owns the whole lifecycle.
    expect(capture.errors).toEqual([])
    expect(capture.exits).toEqual([])
    expect(capture.finishes).toEqual([])
  })

  it('registers the RunManager session before either transport starts', async () => {
    // The API lane has no child process, while agy intentionally requires an
    // existing session before the shared CLI launcher will spawn. Both must
    // therefore claim the exact run before entering their transport.
    const order: string[] = []
    const { deps, capture } = createDeps({
      runGeminiApiAgentTurn: async () => {
        order.push('turn')
      }
    })
    const originalRegister = deps.registerRunSession
    ;(deps as { registerRunSession: typeof deps.registerRunSession }).registerRunSession = (
      route
    ) => {
      order.push('register')
      return originalRegister(route)
    }

    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(order).toEqual(['register', 'turn'])
    expect(capture.sessionRegistrations).toEqual([{ appRunId: RUN_ID, appChatId: CHAT_ID }])

    const agyOrder: string[] = []
    const { deps: agyDeps, capture: agyCapture } = createDeps({
      registerRunSession: (route) => {
        agyOrder.push('register')
        agyCapture.sessionRegistrations.push({ ...route })
        return { provider: 'antigravity', status: 'starting' }
      },
      runAgyProvider: async () => {
        agyOrder.push('agy')
      }
    })
    await dispatchAntigravityCombinedMode(
      mockEvent(),
      basePayload({ model: 'claude-sonnet-4' }),
      agyDeps
    )
    expect(agyOrder).toEqual(['register', 'agy'])
    expect(agyCapture.sessionRegistrations).toEqual([{ appRunId: RUN_ID, appChatId: CHAT_ID }])
  })

  it('rejects the dispatch visibly when session registration is refused', async () => {
    // A refused registration (e.g. the history-clear admission fence) must
    // reject the run-agent invoke so the renderer paints a failure — silent
    // terminal projections would themselves be dropped without a session.
    const { deps, capture } = createDeps({
      registerRunSession: () => undefined
    })
    await expect(dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)).rejects.toThrow(
      /could not be registered/
    )
    expect(capture.agentTurnCalls).toEqual([])
    expect(capture.agyCalls).toEqual([])
  })

  it('propagates a throwing registration as a visible invoke rejection', async () => {
    const { deps, capture } = createDeps({
      registerRunSession: () => {
        throw new Error('registration authority changed')
      }
    })
    await expect(dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)).rejects.toThrow(
      'registration authority changed'
    )
    expect(capture.agentTurnCalls).toEqual([])
  })

  it('recovers a fixed-copy terminal exactly once when the agent turn throws', async () => {
    // The agent turn owns its lifecycle; a throw means it died without
    // terminalizing. The registered session must not strand as Working.
    const { deps, capture } = createDeps({
      runGeminiApiAgentTurn: async () => {
        throw new Error(`private detail must not escape`)
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)

    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(JSON.stringify(capture)).not.toContain('private detail')
  })

  it('completes recovery even when individual terminal projections throw', async () => {
    const { deps, capture } = createDeps({
      runGeminiApiAgentTurn: async () => {
        throw new Error('turn died')
      },
      sendAgentCompatError: () => {
        throw new Error('error channel down')
      },
      sendAgentCompatExit: () => {
        throw new Error('exit channel down')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload(), deps)
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
  })

  it('preserves ordinary non-API models on the exact agy path byte-for-byte', async () => {
    const payload = basePayload({ model: 'claude-sonnet-4' })
    const { deps, capture } = createDeps()
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)

    expect(capture.agentTurnCalls).toEqual([])
    expect(capture.sessionRegistrations).toEqual([{ appRunId: RUN_ID, appChatId: CHAT_ID }])
    expect(capture.agyCalls).toHaveLength(1)
    expect(capture.agyCalls[0]).toBe(payload)
  })

  it('keeps alphanumeric/hyphen gemini-api continuations on unchanged agy (token boundary)', async () => {
    const payload = basePayload({ model: 'gemini-apix' })
    const { deps, capture } = createDeps()
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)
    expect(capture.agentTurnCalls).toEqual([])
    expect(capture.agyCalls).toHaveLength(1)
  })

  it('quarantines malformed namespace candidates on the API lane and never falls through to agy', async () => {
    const malformed = [
      'gemini-api:claude-3',
      ' Gemini-API:gemini-2.5-flash',
      'gemini-api :bad',
      'GEMINI-API:gemini-2.5-flash',
      'gemini-api',
      'gemini-api gemini-2.5-flash'
    ]
    for (const model of malformed) {
      const { deps, capture } = createDeps()
      await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model }), deps)
      expect(capture.agyCalls).toEqual([])
      expect(capture.agentTurnCalls).toHaveLength(1)
      expect(capture.agentTurnCalls[0]?.payload.model).toBe(model)
    }
  })

  it('preserves incoming appChatId/appRunId exactly and never synthesizes IDs', async () => {
    const { deps, capture } = createDeps()
    await dispatchAntigravityCombinedMode(
      mockEvent(),
      basePayload({ appChatId: ' chat-exact ', appRunId: ' run-exact ' }),
      deps
    )
    expect(capture.agentTurnCalls[0]?.route).toEqual({
      appChatId: ' chat-exact ',
      appRunId: ' run-exact '
    })

    const { deps: absentDeps, capture: absentCapture } = createDeps()
    const payload = basePayload()
    delete (payload as unknown as Record<string, unknown>).appChatId
    delete (payload as unknown as Record<string, unknown>).appRunId
    await dispatchAntigravityCombinedMode(mockEvent(), payload, absentDeps)
    expect(absentCapture.agentTurnCalls[0]?.route).toEqual({})
  })
})

const ACP_MODEL = 'antigravity-acp:gemini-3-pro'

describe('isAntigravityAcpModelCandidate', () => {
  it('admits exact, case-variant, whitespace, and malformed-separator namespace candidates', () => {
    expect(isAntigravityAcpModelCandidate(ACP_MODEL)).toBe(true)
    expect(isAntigravityAcpModelCandidate('antigravity-acp:claude-3')).toBe(true)
    expect(isAntigravityAcpModelCandidate(' Antigravity-ACP:gemini-3-pro')).toBe(true)
    expect(isAntigravityAcpModelCandidate('antigravity-acp :gemini-3-pro')).toBe(true)
    expect(isAntigravityAcpModelCandidate('ANTIGRAVITY-ACP:gemini-3-pro')).toBe(true)
    expect(isAntigravityAcpModelCandidate('\tantigravity-acp:gemini-3-pro\n')).toBe(true)
    // Colonless / space-delimited variants must also quarantine (never reach agy).
    expect(isAntigravityAcpModelCandidate('antigravity-acp')).toBe(true)
    expect(isAntigravityAcpModelCandidate('ANTIGRAVITY-ACP')).toBe(true)
    expect(isAntigravityAcpModelCandidate('antigravity-acp gemini-3-pro')).toBe(true)
    expect(isAntigravityAcpModelCandidate('antigravity-acp/gemini-3-pro')).toBe(true)
  })

  it('leaves ordinary models and alphanumeric/hyphen continuations on the agy lane', () => {
    expect(isAntigravityAcpModelCandidate('gemini-2.5-flash')).toBe(false)
    expect(isAntigravityAcpModelCandidate('gemini-api:gemini-2.5-flash')).toBe(false)
    expect(isAntigravityAcpModelCandidate('claude-sonnet-4')).toBe(false)
    expect(isAntigravityAcpModelCandidate('cli-default')).toBe(false)
    expect(isAntigravityAcpModelCandidate('')).toBe(false)
    expect(isAntigravityAcpModelCandidate(undefined)).toBe(false)
    expect(isAntigravityAcpModelCandidate(null)).toBe(false)
    // Token-boundary: alphanumeric or hyphen continuation must NOT quarantine.
    expect(isAntigravityAcpModelCandidate('antigravity-acpx')).toBe(false)
    expect(isAntigravityAcpModelCandidate('antigravity-acp2')).toBe(false)
    expect(isAntigravityAcpModelCandidate('antigravity-acp-extra')).toBe(false)
  })
})

describe('dispatchAntigravityCombinedMode official-ACP lane', () => {
  it('terminalizes with enable-the-switch copy when the transport switch dep is absent or false', async () => {
    for (const isAcpTransportEnabled of [undefined, () => false]) {
      const { deps, capture } = createDeps({ isAcpTransportEnabled })
      await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model: ACP_MODEL }), deps)

      expect(capture.errors).toEqual([ANTIGRAVITY_ACP_TRANSPORT_DISABLED_MESSAGE])
      expect(capture.exits).toEqual([1])
      expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
      // Exit seals the renderer run and finish releases persistence authority,
      // so the terminal order is part of the contract.
      expect(capture.terminalOrder).toEqual(['error', 'exit', 'finish'])
      // Never falls through to another lane.
      expect(capture.agyCalls).toEqual([])
      expect(capture.agentTurnCalls).toEqual([])
      expect(capture.sessionRegistrations).toEqual([{ appRunId: RUN_ID, appChatId: CHAT_ID }])
    }
  })

  it('terminalizes with not-connected copy when the switch is on but no provider is wired', async () => {
    const { deps, capture } = createDeps({ isAcpTransportEnabled: () => true })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model: ACP_MODEL }), deps)

    expect(capture.errors).toEqual([ANTIGRAVITY_ACP_LANE_NOT_CONNECTED_MESSAGE])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.terminalOrder).toEqual(['error', 'exit', 'finish'])
    expect(capture.agyCalls).toEqual([])
    expect(capture.agentTurnCalls).toEqual([])
  })

  it('routes enabled, wired ACP candidates to the official provider with exact payload and route', async () => {
    const acpCalls: Array<{
      payload: AgentRunPayload
      route: { appChatId?: string; appRunId?: string }
    }> = []
    const { deps, capture } = createDeps({
      isAcpTransportEnabled: () => true,
      runOfficialAcpProvider: async (_event, payload, route) => {
        acpCalls.push({ payload, route: { ...route } })
      }
    })
    const payload = basePayload({ model: ACP_MODEL })
    await dispatchAntigravityCombinedMode(mockEvent(), payload, deps)

    expect(acpCalls).toHaveLength(1)
    expect(acpCalls[0]?.payload).toBe(payload)
    expect(acpCalls[0]?.route).toEqual({ appRunId: RUN_ID, appChatId: CHAT_ID })
    // The provider owns its lifecycle — dispatch adds no terminal projections.
    expect(capture.errors).toEqual([])
    expect(capture.exits).toEqual([])
    expect(capture.finishes).toEqual([])
    expect(capture.agyCalls).toEqual([])
    expect(capture.agentTurnCalls).toEqual([])
    expect(capture.sessionRegistrations).toEqual([{ appRunId: RUN_ID, appChatId: CHAT_ID }])
  })

  it('recovers a fixed-copy terminal exactly once when the official provider throws', async () => {
    const { deps, capture } = createDeps({
      isAcpTransportEnabled: () => true,
      runOfficialAcpProvider: async () => {
        throw new Error('private detail must not escape')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model: ACP_MODEL }), deps)

    expect(capture.errors).toEqual([ANTIGRAVITY_ACP_TURN_UNAVAILABLE_MESSAGE])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
    expect(capture.terminalOrder).toEqual(['error', 'exit', 'finish'])
    expect(JSON.stringify(capture)).not.toContain('private detail')
  })

  it('completes ACP recovery even when individual terminal projections throw', async () => {
    const { deps, capture } = createDeps({
      isAcpTransportEnabled: () => true,
      runOfficialAcpProvider: async () => {
        throw new Error('turn died')
      },
      sendAgentCompatError: () => {
        throw new Error('error channel down')
      },
      sendAgentCompatExit: () => {
        throw new Error('exit channel down')
      }
    })
    await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model: ACP_MODEL }), deps)
    expect(capture.finishes).toEqual([{ runId: RUN_ID, status: 'failed' }])
  })

  it('keeps malformed ACP candidates off the agy lane even with the switch off', async () => {
    const malformed = [
      'antigravity-acp',
      ' ANTIGRAVITY-ACP ',
      'antigravity-acp :bad',
      'antigravity-acp gemini-3-pro'
    ]
    for (const model of malformed) {
      const { deps, capture } = createDeps()
      await dispatchAntigravityCombinedMode(mockEvent(), basePayload({ model }), deps)
      expect(capture.agyCalls).toEqual([])
      expect(capture.agentTurnCalls).toEqual([])
      expect(capture.errors).toEqual([ANTIGRAVITY_ACP_TRANSPORT_DISABLED_MESSAGE])
    }
  })
})
