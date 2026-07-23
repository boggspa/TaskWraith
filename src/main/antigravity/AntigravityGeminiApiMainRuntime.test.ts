import { describe, expect, it, vi } from 'vitest'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import {
  ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
  ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
  mapAntigravityGeminiApiTurnStatusToMessage,
  runAntigravityGeminiApiMainTurn,
  type AntigravityGeminiApiMainRuntimeDependencies,
  type AntigravityGeminiApiRunRequest
} from './AntigravityGeminiApiMainRuntime'
import type {
  AntigravityGeminiApiTurnResult,
  AntigravityGeminiApiTurnStatus
} from './AntigravityGeminiApiTurnKernel'

const MODEL = 'gemini-api:gemini-2.5-flash'
const PROMPT = 'Hello'
const ROUTE: AgentRunRoute = { appRunId: 'run-1', appChatId: 'chat-1' }
const SETTINGS = { antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_000 }
const API_KEY = 'AIza-explicit-user-supplied-test-key'
const SENTINEL = 'sentinel-untrusted-runtime-leak'

type LifecycleCapture = {
  inits: unknown[]
  contents: unknown[]
  results: unknown[]
  errors: string[]
  exits: Array<number | null>
  finishes: Array<'completed' | 'failed' | 'cancelled'>
  attached: Array<{ runId: string | undefined; controller: AbortController }>
  streamCalls: Array<{ abortSignal?: AbortSignal }>
}

function captureDeps(
  streamTurn: AntigravityGeminiApiMainRuntimeDependencies['streamTurn'],
  overrides: Partial<AntigravityGeminiApiMainRuntimeDependencies> = {}
): { deps: AntigravityGeminiApiMainRuntimeDependencies; capture: LifecycleCapture } {
  const capture: LifecycleCapture = {
    inits: [],
    contents: [],
    results: [],
    errors: [],
    exits: [],
    finishes: [],
    attached: [],
    streamCalls: []
  }

  const wrappedStreamTurn: NonNullable<
    AntigravityGeminiApiMainRuntimeDependencies['streamTurn']
  > = async (settings, request, turnDeps) => {
    capture.streamCalls.push({ abortSignal: turnDeps.abortSignal })
    return (streamTurn ?? (async () => ({ status: 'empty', chunks: 0, textChars: 0 })))(
      settings,
      request,
      turnDeps
    )
  }

  const deps: AntigravityGeminiApiMainRuntimeDependencies = {
    secretStore: { loadApiKey: vi.fn(() => ({ status: 'ok' as const, value: API_KEY })) },
    streamTurn: wrappedStreamTurn,
    emitInit: (payload) => {
      capture.inits.push(payload)
    },
    emitContent: (payload) => {
      capture.contents.push(payload)
    },
    emitResult: (payload) => {
      capture.results.push(payload)
    },
    emitError: (message) => {
      capture.errors.push(message)
    },
    emitExit: (code) => {
      capture.exits.push(code)
    },
    finishRun: (status) => {
      capture.finishes.push(status)
    },
    attachAbortController: (runId, controller) => {
      capture.attached.push({ runId, controller })
    },
    now: () => 1_700_000_000_000,
    ...overrides
  }

  return { deps, capture }
}

function request(
  overrides: Partial<AntigravityGeminiApiRunRequest> = {}
): AntigravityGeminiApiRunRequest {
  return { model: MODEL, prompt: PROMPT, route: ROUTE, ...overrides }
}

function okResult(text = 'Hi there'): AntigravityGeminiApiTurnResult {
  return {
    status: 'ok',
    model: MODEL,
    chunks: 1,
    textChars: text.length,
    usage: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 }
  }
}

function failResult(
  status: Exclude<AntigravityGeminiApiTurnStatus, 'ok'>
): AntigravityGeminiApiTurnResult {
  return { status, model: MODEL, chunks: 0, textChars: 0 }
}

function serialized(capture: LifecycleCapture): string {
  return JSON.stringify([
    ...capture.inits,
    ...capture.contents,
    ...capture.results,
    ...capture.errors,
    ...capture.exits,
    ...capture.finishes
  ])
}

describe('runAntigravityGeminiApiMainTurn', () => {
  it('emits init, streamed content, success result, and exit in order', async () => {
    const { deps, capture } = captureDeps(async (_settings, _request, turnDeps) => {
      await turnDeps.onText('Hello ')
      await turnDeps.onText('world')
      return okResult('Hello world')
    })

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.inits).toHaveLength(1)
    expect(capture.contents).toHaveLength(2)
    expect(capture.results).toHaveLength(1)
    expect(capture.exits).toEqual([0])
    expect(capture.finishes).toEqual(['completed'])
    expect(capture.errors).toEqual([])
    expect(capture.inits[0]).toMatchObject({
      type: 'init',
      session_id: 'chat-1',
      model: MODEL,
      provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
      runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
      fallback: false
    })
    expect(capture.contents[0]).toEqual({
      type: 'content',
      text: 'Hello ',
      provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
      runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL
    })
    expect(capture.results[0]).toMatchObject({
      type: 'result',
      status: 'success',
      provider: ANTIGRAVITY_GEMINI_API_PROVIDER_LABEL,
      runtime: ANTIGRAVITY_GEMINI_API_RUNTIME_LABEL,
      providerThreadId: 'chat-1',
      fallback: false
    })
  })

  it('attaches the exact AbortController before the kernel stream starts', async () => {
    const controller = new AbortController()
    let attachedBeforeStream = false
    const { deps, capture } = captureDeps(
      async (_settings, _request, turnDeps) => {
        attachedBeforeStream =
          capture.attached.length === 1 && capture.attached[0]?.controller === controller
        expect(turnDeps.abortSignal).toBe(controller.signal)
        return okResult()
      },
      { createAbortController: vi.fn(() => controller) }
    )

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(deps.createAbortController).toHaveBeenCalledTimes(1)
    expect(capture.attached).toEqual([{ runId: 'run-1', controller }])
    expect(attachedBeforeStream).toBe(true)
  })

  it('terminalizes cancelled turns exactly once with exit 130 and no success result', async () => {
    const { deps, capture } = captureDeps(async () => failResult('cancelled'))

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.errors).toEqual([])
    expect(capture.results).toEqual([])
    expect(capture.exits).toEqual([130])
    expect(capture.finishes).toEqual(['cancelled'])
  })

  it('maps every non-ok kernel status to fixed nonsecret failure messages', async () => {
    const statuses = [
      'disclosureRequired',
      'keyUnavailable',
      'invalidModel',
      'invalidPrompt',
      'sdkUnavailable',
      'unauthorized',
      'rateLimited',
      'projectLimited',
      'unavailable',
      'invalidResponse',
      'empty'
    ] as const

    for (const status of statuses) {
      const { deps, capture } = captureDeps(async () => failResult(status))
      await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)
      expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage(status)])
      expect(capture.results).toHaveLength(1)
      expect(capture.exits).toEqual([1])
      expect(capture.finishes).toEqual(['failed'])
    }
  })

  it('does not reflect raw SDK, key, or sentinel text in emitted errors and results', async () => {
    const { deps, capture } = captureDeps(async () => ({
      status: 'unauthorized' as const,
      model: MODEL,
      chunks: 0,
      textChars: 0
    }))

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    const failurePayload = JSON.stringify([...capture.errors, ...capture.results])
    expect(failurePayload).not.toContain(API_KEY)
    expect(failurePayload).not.toContain(SENTINEL)
  })

  it('ignores duplicate late kernel completion after content callback failure terminalized the turn', async () => {
    const { deps, capture } = captureDeps(
      async (_settings, _request, turnDeps) => {
        await turnDeps.onText('boom')
        return okResult()
      },
      {
        emitContent: vi.fn(() => {
          throw new Error(SENTINEL)
        })
      }
    )

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.results).toHaveLength(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain(SENTINEL)
  })

  it('terminalizes exactly once when lifecycle callbacks throw during failure handling', async () => {
    const emitError = vi.fn(() => {
      throw new Error(SENTINEL)
    })
    const emitResult = vi.fn(() => {
      throw new Error(`${SENTINEL}-result`)
    })
    const emitExit = vi.fn(() => {
      throw new Error(`${SENTINEL}-exit`)
    })
    const finishRun = vi.fn(() => {
      throw new Error(`${SENTINEL}-finish`)
    })
    const { deps } = captureDeps(async () => failResult('unauthorized'), {
      emitError,
      emitResult,
      emitExit,
      finishRun
    })

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(emitError).toHaveBeenCalledTimes(1)
    expect(emitResult).toHaveBeenCalledTimes(1)
    expect(emitExit).toHaveBeenCalledTimes(1)
    expect(finishRun).toHaveBeenCalledTimes(1)
    expect(emitError).toHaveBeenCalledWith(
      mapAntigravityGeminiApiTurnStatusToMessage('unauthorized')
    )
  })

  it('resolves cancelled when abort fires before streaming begins', async () => {
    const controller = new AbortController()
    const { deps, capture } = captureDeps(
      async (_settings, _request, turnDeps) => {
        controller.abort()
        expect(turnDeps.abortSignal?.aborted).toBe(true)
        return failResult('cancelled')
      },
      { createAbortController: vi.fn(() => controller) }
    )

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.exits).toEqual([130])
    expect(capture.finishes).toEqual(['cancelled'])
    expect(capture.errors).toEqual([])
  })

  it('resolves cancelled when abort fires during streaming and never emits success afterward', async () => {
    const controller = new AbortController()
    const { deps, capture } = captureDeps(
      async (_settings, _request, turnDeps) => {
        await turnDeps.onText('partial')
        controller.abort()
        return failResult('cancelled')
      },
      { createAbortController: vi.fn(() => controller) }
    )

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.contents).toHaveLength(1)
    expect(capture.exits).toEqual([130])
    expect(capture.finishes).toEqual(['cancelled'])
    expect(capture.results).toEqual([])
  })

  it('does not emit further content after terminalization begins', async () => {
    let contentCalls = 0
    const localContents: unknown[] = []
    const { deps, capture } = captureDeps(
      async (_settings, _request, turnDeps) => {
        await turnDeps.onText('first')
        await turnDeps.onText('second')
        return okResult()
      },
      {
        emitContent: (payload) => {
          contentCalls += 1
          localContents.push(payload)
          if (contentCalls === 2) {
            throw new Error(SENTINEL)
          }
        }
      }
    )

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(localContents).toHaveLength(2)
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain(SENTINEL)
  })

  it('uses run id session identity when chat id is absent', async () => {
    const { deps, capture } = captureDeps(async () => okResult())

    await runAntigravityGeminiApiMainTurn(
      SETTINGS,
      request({ route: { appRunId: 'run-only' } }),
      deps
    )

    expect(capture.inits[0]).toMatchObject({ session_id: 'run-only' })
  })

  it('fails closed without inventing an identity when neither route identity is supplied', async () => {
    const streamTurn = vi.fn(async () => okResult())
    const { deps, capture } = captureDeps(streamTurn)

    await runAntigravityGeminiApiMainTurn(SETTINGS, request({ route: {} }), deps)

    expect(streamTurn).not.toHaveBeenCalled()
    expect(capture.inits).toEqual([])
    expect(capture.results).toEqual([])
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain('gemini-api-turn://')
    expect(serialized(capture)).not.toContain('ephemeral')
  })

  it('ignores whitespace-only identities and fails closed without synthesis', async () => {
    const streamTurn = vi.fn(async () => okResult())
    const { deps, capture } = captureDeps(streamTurn)

    await runAntigravityGeminiApiMainTurn(
      SETTINGS,
      request({ route: { appChatId: '   ', appRunId: '\t' } }),
      deps
    )

    expect(streamTurn).not.toHaveBeenCalled()
    expect(capture.inits).toEqual([])
    expect(capture.results).toEqual([])
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual(['failed'])
  })

  it('preserves the selected chat identity byte-for-byte without rewriting it', async () => {
    const chatId = ' chat/id:with spaces '
    const { deps, capture } = captureDeps(async () => okResult(), {
      now: () => 1_700_000_000_123
    })

    await runAntigravityGeminiApiMainTurn(
      SETTINGS,
      request({ route: { appChatId: chatId, appRunId: 'run-fallback' } }),
      deps
    )

    expect(capture.inits[0]).toMatchObject({ session_id: chatId })
    expect(capture.results[0]).toMatchObject({ providerThreadId: chatId })
  })

  it('fails closed when abort-controller attachment throws and never starts the kernel', async () => {
    const streamTurn = vi.fn(async () => okResult())
    const { deps, capture } = captureDeps(streamTurn, {
      attachAbortController: vi.fn(() => {
        throw new Error(`${SENTINEL}-${API_KEY}`)
      })
    })

    await expect(
      runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)
    ).resolves.toBeUndefined()

    expect(streamTurn).not.toHaveBeenCalled()
    expect(capture.inits).toEqual([])
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.results).toHaveLength(1)
    expect(capture.exits).toEqual([1])
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain(SENTINEL)
    expect(serialized(capture)).not.toContain(API_KEY)
  })

  it('passes the injected secret store through to the kernel without fallback transports', async () => {
    const secretStore = { loadApiKey: vi.fn(() => ({ status: 'ok' as const, value: API_KEY })) }
    const streamTurn = vi.fn(async () => okResult())
    const { deps } = captureDeps(streamTurn, { secretStore })

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(streamTurn).toHaveBeenCalledWith(
      SETTINGS,
      { model: MODEL, prompt: PROMPT },
      expect.objectContaining({ secretStore, abortSignal: expect.any(AbortSignal) })
    )
  })

  it('terminalizes unavailable when the injected kernel throws', async () => {
    const { deps, capture } = captureDeps(async () => {
      throw new Error(SENTINEL)
    })

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain(SENTINEL)
  })

  it('terminalizes unavailable when init throws before streaming', async () => {
    const { deps, capture } = captureDeps(async () => okResult(), {
      emitInit: vi.fn(() => {
        throw new Error(SENTINEL)
      })
    })

    await runAntigravityGeminiApiMainTurn(SETTINGS, request(), deps)

    expect(capture.streamCalls).toHaveLength(0)
    expect(capture.errors).toEqual([mapAntigravityGeminiApiTurnStatusToMessage('unavailable')])
    expect(capture.finishes).toEqual(['failed'])
    expect(serialized(capture)).not.toContain(SENTINEL)
  })
})

describe('mapAntigravityGeminiApiTurnStatusToMessage', () => {
  it('returns fixed nonsecret messages for every failure status', () => {
    expect(mapAntigravityGeminiApiTurnStatusToMessage('invalidModel')).toBe(
      'The selected Gemini API model route is invalid.'
    )
    expect(mapAntigravityGeminiApiTurnStatusToMessage('empty')).toBe('Gemini API returned no text.')
  })
})
