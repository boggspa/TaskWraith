import { describe, expect, it, vi } from 'vitest'
import {
  OllamaLocalAdmissionPolicy,
  localOllamaModelKey,
  localOllamaModelKeys
} from './OllamaLocalAdmissionPolicy'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function psResponse(models: string[]): Response {
  return {
    ok: true,
    json: async () => ({ models: models.map((model) => ({ model })) })
  } as unknown as Response
}

function policyWith(options: {
  env?: Record<string, string | undefined>
  resident?: string[]
  reachable?: boolean
  clock?: { ms: number }
}) {
  const clock = options.clock ?? { ms: 0 }
  const fetchImpl = vi.fn(async () => {
    if (options.reachable === false) throw new Error('ECONNREFUSED')
    return psResponse(options.resident ?? [])
  }) as unknown as typeof fetch
  const policy = new OllamaLocalAdmissionPolicy({
    getBaseUrl: () => 'http://127.0.0.1:11434',
    getEnv: () => options.env ?? {},
    fetchImpl,
    now: () => clock.ms
  })
  return { policy, clock, fetchImpl }
}

describe('localOllamaModelKey', () => {
  it('ignores every provider that is not ollama', () => {
    expect(localOllamaModelKey({ provider: 'claude', model: 'opus' })).toBeUndefined()
    expect(localOllamaModelKey({ provider: 'codex', model: 'gpt-5.6' })).toBeUndefined()
    expect(localOllamaModelKey({ provider: 'ollama', model: 'qwen3:8b' })).toBe('qwen3:8b')
  })

  it('ignores Ollama Cloud models, which hold no local VRAM', () => {
    expect(localOllamaModelKey({ provider: 'ollama', model: 'kimi-k3:cloud' })).toBeUndefined()
    expect(localOllamaModelKey({ provider: 'ollama', model: 'glm-5.2-cloud' })).toBeUndefined()
  })

  it('folds tag aliases onto one key so two spellings share one slot', () => {
    const bare = localOllamaModelKey({ provider: 'ollama', model: 'gemma3' })
    const latest = localOllamaModelKey({ provider: 'ollama', model: 'gemma3:latest' })
    expect(bare).toBe(latest)
    expect(localOllamaModelKey({ provider: 'ollama', model: 'gemma3:27b' })).not.toBe(bare)
  })

  it('groups model-less local seats under one key rather than leaving them ungated', () => {
    const a = localOllamaModelKey({ provider: 'ollama' })
    const b = localOllamaModelKey({ provider: 'ollama', model: '  ' })
    expect(a).toBeDefined()
    expect(a).toBe(b)
  })

  it('collects distinct keys for reconcile', () => {
    expect(
      localOllamaModelKeys([
        { provider: 'ollama', model: 'qwen3:8b' },
        { provider: 'ollama', model: 'qwen3:8b' },
        { provider: 'claude', model: 'opus' },
        { provider: 'ollama', model: 'kimi-k3:cloud' }
      ])
    ).toEqual(['qwen3:8b'])
  })
})

describe('OllamaLocalAdmissionPolicy capacity sourcing', () => {
  it('stays unbounded when the host declares nothing', async () => {
    const { policy } = policyWith({ env: {}, resident: ['a', 'b', 'c'] })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'ollama', model: 'b' })
    await policy.admit('run-3', { provider: 'ollama', model: 'c' })
    expect(policy.waiting).toBe(0)
    expect(policy.capacityEstimate?.ceiling).toBeUndefined()
  })

  it('stays unbounded when the probe cannot reach the host', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' }, reachable: false })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'ollama', model: 'b' })
    expect(policy.waiting).toBe(0)
    expect(policy.capacityEstimate?.ceiling).toBeUndefined()
  })

  it('bounds distinct models at a declared ceiling and queues the rest', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '2' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'ollama', model: 'b' })
    const queued = policy.admit('run-3', { provider: 'ollama', model: 'c' })
    let settled = false
    void queued.then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(false)
    expect(policy.waiting).toBe(1)

    policy.releaseRun('run-1', [])
    await settle()
    expect(settled).toBe(true)
    expect(policy.waiting).toBe(0)
  })

  it('never charges a non-ollama seat a slot', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'claude', model: 'opus' })
    await policy.admit('run-3', { provider: 'codex', model: 'gpt-5.6' })
    expect(policy.inFlight).toBe(1)
    expect(policy.waiting).toBe(0)
  })

  it('widens a stale declared ceiling by measured residency, never narrows it', async () => {
    const { policy } = policyWith({
      env: { OLLAMA_MAX_LOADED_MODELS: '2' },
      resident: ['a', 'b', 'c', 'd']
    })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    expect(policy.capacityEstimate?.ceiling).toBe(4)
    expect(policy.capacityEstimate?.source).toBe('observed')
  })
})

describe('OllamaLocalAdmissionPolicy slot hygiene', () => {
  it('releases every slot a run held when the run finalizes', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    expect(policy.inFlight).toBe(1)
    policy.releaseRun('run-1', [])
    expect(policy.inFlight).toBe(0)
  })

  it('rejects a still-queued admission when its run finalizes, instead of stranding it', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    const queued = policy.admit('run-2', { provider: 'ollama', model: 'b' })
    const caught = queued.catch((error: Error) => error.name)
    await settle()
    expect(policy.waiting).toBe(1)

    policy.releaseRun('run-2', [{ provider: 'ollama', model: 'a' }])
    await expect(caught).resolves.toBe('AbortError')
    expect(policy.waiting).toBe(0)
  })

  it('hands back a slot granted in the same tick the run was released', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    const queued = policy.admit('run-2', { provider: 'ollama', model: 'b' })
    const caught = queued.catch((error: Error) => error.name)
    await settle()

    // The grant and the release land in the same turn: releasing run-1 drains
    // the waiter, and run-2 finalizes before its continuation runs.
    policy.releaseRun('run-1', [])
    policy.releaseRun('run-2', [])
    await expect(caught).resolves.toBe('AbortError')
    expect(policy.inFlight).toBe(0)
  })

  it('reclaims a slot whose run vanished without ever releasing it', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '2' } })
    await policy.admit('ghost', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'ollama', model: 'b' })
    expect(policy.inFlight).toBe(2)

    // `ghost` crashed: it never finalized, so only durable state knows it is
    // gone. Reconcile is driven by the live run registry, not the gate.
    policy.releaseRun('run-2', [])
    expect(policy.inFlight).toBe(0)
  })

  it('does not reclaim a slot a live run is still holding', async () => {
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '2' } })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    await policy.admit('run-2', { provider: 'ollama', model: 'b' })
    policy.releaseRun('run-2', [{ provider: 'ollama', model: 'a' }])
    expect(policy.inFlight).toBe(1)
  })
})

describe('OllamaLocalAdmissionPolicy deadlines', () => {
  it('leaves an unqueued deadline byte-identical', async () => {
    const clock = { ms: 10_000 }
    const { policy } = policyWith({ env: {}, clock })
    await policy.admit('run-1', { provider: 'ollama', model: 'a' })
    expect(policy.effectiveDeadline(10_000 + 30_000, ['run-1'])).toBe(40_000)
  })

  it('extends by the WORST queued lane, not the sum of them', async () => {
    const clock = { ms: 0 }
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' }, clock })
    await policy.admit('owner', { provider: 'ollama', model: 'a' })
    void policy.admit('lane-1', { provider: 'ollama', model: 'b' }).catch(() => undefined)
    void policy.admit('lane-2', { provider: 'ollama', model: 'c' }).catch(() => undefined)
    await settle()

    clock.ms = 5_000
    // Two lanes queued 5s each. Summing would buy 10s of extra patience for a
    // round that only actually lost 5s.
    expect(policy.effectiveDeadline(30_000, ['owner', 'lane-1', 'lane-2'])).toBe(35_000)
  })

  it('keeps extending while a lane is still queued, so it cannot time out unstarted', async () => {
    const clock = { ms: 0 }
    const { policy } = policyWith({ env: { OLLAMA_MAX_LOADED_MODELS: '1' }, clock })
    await policy.admit('owner', { provider: 'ollama', model: 'a' })
    void policy.admit('lane-1', { provider: 'ollama', model: 'b' }).catch(() => undefined)
    await settle()

    clock.ms = 60_000
    expect(policy.effectiveDeadline(30_000, ['lane-1'])).toBe(90_000)
    clock.ms = 600_000
    expect(policy.effectiveDeadline(30_000, ['lane-1'])).toBe(630_000)
  })

  it('ignores run ids that never queued', async () => {
    const { policy } = policyWith({ env: {} })
    expect(policy.effectiveDeadline(30_000, ['never-seen'])).toBe(30_000)
    expect(policy.effectiveDeadline(30_000, [])).toBe(30_000)
  })
})

describe('OllamaLocalAdmissionPolicy dispatch ordering', () => {
  it('admits a wave in call order even though the first seat pays for the probe', async () => {
    let releaseProbe = (): void => undefined
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const fetchImpl = (async () => {
      await probeGate
      return psResponse([])
    }) as unknown as typeof fetch
    const policy = new OllamaLocalAdmissionPolicy({
      getBaseUrl: () => 'http://127.0.0.1:11434',
      getEnv: () => ({}),
      fetchImpl
    })

    const admitted: string[] = []
    const wave = ['seat-a', 'seat-b', 'seat-c'].map((id) =>
      policy.admit(id, { provider: 'ollama', model: id }).then(() => {
        admitted.push(id)
      })
    )
    await settle()
    expect(admitted).toEqual([])

    releaseProbe()
    await Promise.all(wave)
    expect(admitted).toEqual(['seat-a', 'seat-b', 'seat-c'])
  })
})
