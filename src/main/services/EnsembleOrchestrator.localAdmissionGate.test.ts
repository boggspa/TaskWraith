import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * Local Ollama seats share one runner and one pool of VRAM, so a wide fan-out
 * of them does not run wide — it thrashes, loading and evicting weights until
 * (on 2026-08-18) Apple's GPU driver panicked the machine outright.
 *
 * Exercised through the real dispatch path rather than the pure policy module,
 * because what the gate is worth depends entirely on being WIRED: the modules
 * sat in the tree for three commits with no importer, passing all their own
 * tests, changing nothing. The two failure directions this pins are the ones
 * that fail silently — gating a provider that should never have been gated,
 * and leaking a slot so the round wedges shut with no visible cause.
 */

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  model: string
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model,
    permissionPresetId: 'workspace_write'
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Local admission gate',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      fanoutPolicy: 'read_only',
      participants
    }
  } as unknown as ChatRecord
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

function makeHarness(participants: EnsembleParticipant[]) {
  let chat = makeChat(participants)
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: makeSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-08-18T00:00:0${counter}.000Z`
  } as unknown as ConstructorParameters<typeof EnsembleOrchestrator>[0])
  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator
  }
}

type Harness = ReturnType<typeof makeHarness>

function complete(harness: Harness, index: number): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'result', status: 'success' }
  )
}

/** A reachable host holding nothing, so only the declared ceiling speaks. */
function stubReachableOllama(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }))
  )
}

function localTrio() {
  return [
    participant('lead', 'codex', 'Lead', 1, 'gpt-5.6'),
    participant('scout', 'ollama', 'Scout', 2, 'qwen3:8b'),
    participant('auditor', 'ollama', 'Auditor', 3, 'gemma3:27b'),
    participant('scribe', 'ollama', 'Scribe', 4, 'granite4:32b')
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('local Ollama admission gate, wired into dispatch', () => {
  it(
    'holds a wide local fan-out at the host ceiling and releases as lanes settle',
    { timeout: 30_000 },
    async () => {
      vi.stubEnv('OLLAMA_MAX_LOADED_MODELS', '2')
      stubReachableOllama()
      const harness = makeHarness(localTrio())
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out to every local seat at once.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      // NOT awaited: with three local lanes and room for two, the third is
      // queued, and the fan-out call itself does not return until it has run.
      // That backpressure is the point — a queued lane is a slow success, not
      // a refusal and not a dropped seat.
      const wave = harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scout', 'Auditor', 'Scribe'],
        prompt: 'Three local seats, one call.'
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      // The load-bearing assertion: the third local model is NOT loaded.
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(harness.dispatched).toHaveLength(3)
      expect(harness.dispatched.map((payload) => payload.model)).toEqual([
        'gpt-5.6',
        'qwen3:8b',
        'gemma3:27b'
      ])

      // Settling a lane hands its slot back through finalizeRun.
      complete(harness, 1)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(harness.dispatched[3].model).toBe('granite4:32b')

      complete(harness, 2)
      complete(harness, 3)
      const settled = await wave
      expect(settled.ok).toBe(true)
      expect(settled.laneIds).toHaveLength(3)
    }
  )

  it(
    'leaves a host that declares no ceiling completely unbounded',
    { timeout: 30_000 },
    async () => {
      // The invariant that protects every big-GPU user: no declaration means
      // no opinion, and no opinion means the code path from before this gate
      // existed. A guessed ceiling here would serialise a rack of H100s.
      //
      // "Declares no ceiling" is a premise, not a default, and it must be
      // pinned: the policy reads process.env, and a dev machine may genuinely
      // export OLLAMA_MAX_LOADED_MODELS to every process (this repo's does,
      // launchd-wide, since the 2026-08-18 GPU panic). Inherit that and the
      // wave bounds to the machine's ceiling — the third lane queues behind a
      // completion this test never sends, and the awaited fan-out never
      // returns.
      vi.stubEnv('OLLAMA_MAX_LOADED_MODELS', undefined)
      stubReachableOllama()
      const harness = makeHarness(localTrio())
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Unbounded host fans out.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const wave = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scout', 'Auditor', 'Scribe'],
        prompt: 'Three local seats, no ceiling.'
      })
      expect(wave.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    }
  )

  it('never charges a hosted provider a local slot', { timeout: 30_000 }, async () => {
    // A ceiling of one would serialise the whole round if the gate were keyed
    // on anything broader than "local Ollama seat".
    vi.stubEnv('OLLAMA_MAX_LOADED_MODELS', '1')
    stubReachableOllama()
    const harness = makeHarness([
      participant('lead', 'codex', 'Lead', 1, 'gpt-5.6'),
      participant('claude', 'claude', 'Reviewer', 2, 'opus'),
      participant('grok', 'grok', 'Researcher', 3, 'grok-4'),
      participant('kimi', 'kimi', 'Auditor', 4, 'k3')
    ])
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Hosted seats must fan out wide.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    const boss = harness.dispatched[0].appRunId

    const wave = await harness.orchestrator.fanoutForRun(boss, {
      targets: ['Reviewer', 'Researcher', 'Auditor'],
      prompt: 'Three hosted seats.'
    })
    expect(wave.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
  })

  it(
    'gives a slot back when a local lane fails instead of wedging the round',
    { timeout: 30_000 },
    async () => {
      // A leaked slot is worse than the oversubscription it prevents: the round
      // never reopens and nothing says why. Failure is the path most likely to
      // leak, so it is the one pinned here.
      vi.stubEnv('OLLAMA_MAX_LOADED_MODELS', '1')
      stubReachableOllama()
      const harness = makeHarness(localTrio())
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'One local slot, and the holder fails.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const wave = harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scout', 'Auditor'],
        prompt: 'Two local seats, room for one.'
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      const failing = harness.dispatched[1]
      harness.orchestrator.handleProviderOutput(
        failing.provider,
        { appRunId: failing.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'error', error: 'local runner died' }
      )

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].model).toBe('gemma3:27b')
      complete(harness, 2)
      await wave
    }
  )
})

describe('fan-out cap refusal names local-capacity backpressure', () => {
  it(
    'tells a refused fourth call that waves are waiting on local capacity',
    { timeout: 30_000 },
    async () => {
      // One local slot, and a local lane holding it: the host is saturated, so
      // open waves drain in turns. A refusal that omits that reads as a
      // stalled round, and the observed answer to a misread refusal is
      // shrinking the roster.
      vi.stubEnv('OLLAMA_MAX_LOADED_MODELS', '1')
      stubReachableOllama()
      const harness = makeHarness([
        participant('lead', 'codex', 'Lead', 1, 'gpt-5.6'),
        participant('scout', 'ollama', 'Scout', 2, 'qwen3:8b'),
        participant('reviewer', 'claude', 'Reviewer', 3, 'opus'),
        participant('auditor', 'grok', 'Auditor', 4, 'grok-4'),
        participant('scribe', 'kimi', 'Scribe', 5, 'k3')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead saturates the local host, then over-dispatches.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const first = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scout'],
        prompt: 'Local lane holding the only slot.'
      })
      expect(first.ok).toBe(true)
      const second = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Reviewer'],
        prompt: 'Hosted lane.'
      })
      expect(second.ok).toBe(true)
      const third = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Auditor'],
        prompt: 'Hosted lane.'
      })
      expect(third.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))

      const fourth = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scribe'],
        prompt: 'One wave too many.'
      })
      expect(fourth.ok).toBe(false)
      expect(fourth.error).toBe('too_many_concurrent_fanouts')
      expect(fourth.message).toContain('waiting on local capacity')
      expect(fourth.message).toContain('1 of 1')
      // The anti-roster-shrink copy must survive the addition.
      expect(fourth.message).toMatch(/do not drop seats/i)
      expect(fourth.message).toContain('ensemble_await')
    }
  )

  it(
    'leaves the refusal byte-clean of capacity talk when no local seat is in play',
    { timeout: 30_000 },
    async () => {
      // An all-hosted roster (or a rack of H100s) must read the exact refusal
      // it read before the admission gate existed — it must not even be told a
      // gate exists.
      stubReachableOllama()
      const harness = makeHarness([
        participant('lead', 'codex', 'Lead', 1, 'gpt-5.6'),
        participant('reviewer', 'claude', 'Reviewer', 2, 'opus'),
        participant('auditor', 'grok', 'Auditor', 3, 'grok-4'),
        participant('scribe', 'kimi', 'Scribe', 4, 'k3'),
        participant('helper', 'cursor', 'Helper', 5, 'composer')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Hosted roster over-dispatches.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      for (const target of ['Reviewer', 'Auditor', 'Scribe']) {
        const wave = await harness.orchestrator.fanoutForRun(boss, {
          targets: [target],
          prompt: 'Hosted lane.'
        })
        expect(wave.ok).toBe(true)
      }
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))

      const fourth = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Helper'],
        prompt: 'One wave too many.'
      })
      expect(fourth.ok).toBe(false)
      expect(fourth.error).toBe('too_many_concurrent_fanouts')
      expect(fourth.message).not.toContain('waiting on local capacity')
      expect(fourth.message).not.toContain('model ceiling')
    }
  )
})
