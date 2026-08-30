import { describe, expect, it, vi } from 'vitest'

import {
  HostNodeProviderRegistry,
  validateHostNodeProviderComposition
} from './HostNodeProviderRegistry'
import type { HostNodeProvider, HostNodeProviderInstance } from './HostNodeProvider'

function fakeInstance(providerId: string): HostNodeProviderInstance {
  return {
    providerId,
    getStatus: vi.fn(async () => ({
      providerId,
      status: 'ready' as const,
      label: providerId.toUpperCase()
    })),
    getAuthStatus: vi.fn(async () => ({
      providerId,
      state: 'authenticated' as const
    })),
    getAuthFlows: vi.fn(async () => []),
    beginAuth: vi.fn(async () => undefined),
    cancelAuth: vi.fn(async () => true),
    run: vi.fn(async () => ({ runId: 'run-1', status: 'completed' as const })),
    cancel: vi.fn(() => true),
    shutdown: vi.fn(async () => undefined)
  }
}

function fakeProvider(
  providerId: string,
  overrides: Partial<HostNodeProvider> = {}
): HostNodeProvider {
  return {
    providerId,
    displayProvider: providerId.toUpperCase(),
    shortCode: providerId.slice(0, 3).toUpperCase(),
    offers: {
      providerId,
      offerRevision: `${providerId}-offers-1`,
      models: [
        {
          modelId: `${providerId}-model-1`,
          label: `${providerId} Model`,
          available: true,
          default: true,
          reasoning: []
        }
      ],
      postures: []
    },
    supportsApprovals: false,
    supportsQuestions: false,
    create: () => fakeInstance(providerId),
    ...overrides
  }
}

const runPort = {
  getThread: () => null,
  appendTranscript: () => undefined,
  beginRun: () => ({ kind: 'started' as const }),
  updateRun: () => undefined,
  finishRun: () => undefined,
  registerCancel: () => ({ kind: 'registered' as const }),
  clearCancel: () => undefined,
  publishRunEvent: () => undefined
}

const interactions = { register: () => new Promise<never>(() => {}) }

describe('HostNodeProviderRegistry', () => {
  it('creates instances and dispatches status/auth/offers by provider', async () => {
    const registry = new HostNodeProviderRegistry({
      providers: [fakeProvider('muse')],
      runPort,
      interactions
    })
    expect(registry.hasProvider('muse')).toBe(true)
    expect(registry.hasProvider('claude')).toBe(false)
    expect(registry.getOffers('muse')?.offerRevision).toBe('muse-offers-1')
    expect(registry.getInstance('muse')).toBeDefined()
    const statuses = await registry.providerStatuses()
    expect(statuses).toEqual([{ providerId: 'muse', status: 'ready', label: 'MUSE' }])
    await expect(registry.providerAuthStatus('muse')).resolves.toEqual({
      providerId: 'muse',
      state: 'authenticated'
    })
    await expect(registry.providerAuthFlows('muse')).resolves.toEqual([])
  })

  it('rejects duplicate and non-live providers', () => {
    expect(
      () =>
        new HostNodeProviderRegistry({
          providers: [fakeProvider('muse'), fakeProvider('muse')],
          runPort,
          interactions
        })
    ).toThrow('duplicate')
    expect(
      () =>
        new HostNodeProviderRegistry({
          providers: [fakeProvider('gemini' as 'muse')],
          runPort,
          interactions
        })
    ).toThrow('non-live')
    expect(
      () =>
        new HostNodeProviderRegistry({
          providers: [fakeProvider('antigravity')],
          runPort,
          interactions
        })
    ).toThrow('non-live')
    expect(
      () =>
        new HostNodeProviderRegistry({
          providers: [
            fakeProvider('gemini', {
              conditionalAdmission: 'antigravity-live-guarded'
            })
          ],
          runPort,
          interactions
        })
    ).toThrow('non-live')
  })

  it('accepts only an explicitly guarded conditional AntiGravity adapter', () => {
    const registry = new HostNodeProviderRegistry({
      providers: [
        fakeProvider('antigravity', {
          conditionalAdmission: 'antigravity-live-guarded'
        })
      ],
      runPort,
      interactions
    })
    expect(registry.hasProvider('antigravity')).toBe(true)
  })

  it('refreshes dynamic offers before status/auth reads and updates the cached revision', async () => {
    const instance = fakeInstance('ollama')
    const getOffers = vi
      .fn<NonNullable<HostNodeProviderInstance['getOffers']>>()
      .mockResolvedValueOnce({
        providerId: 'ollama',
        offerRevision: 'signed-out',
        models: [
          { modelId: 'local', label: 'Local', available: true, default: true, reasoning: [] }
        ],
        postures: []
      })
      .mockResolvedValueOnce({
        providerId: 'ollama',
        offerRevision: 'signed-in',
        models: [
          {
            modelId: 'minimax-m3:cloud',
            label: 'MiniMax M3',
            available: true,
            default: true,
            reasoning: []
          }
        ],
        postures: []
      })
      .mockResolvedValueOnce({
        providerId: 'ollama',
        offerRevision: 'signed-out-again',
        models: [
          { modelId: 'local', label: 'Local', available: true, default: true, reasoning: [] }
        ],
        postures: []
      })
    instance.getOffers = getOffers
    const registry = new HostNodeProviderRegistry({
      providers: [fakeProvider('ollama', { create: () => instance })],
      runPort,
      interactions
    })

    await registry.providerStatuses()
    expect(registry.getOffers('ollama')?.offerRevision).toBe('signed-out')
    await registry.providerAuthStatus('ollama')
    expect(registry.getOffers('ollama')?.offerRevision).toBe('signed-in')
    await registry.providerAuthFlows('ollama')
    expect(registry.getOffers('ollama')?.offerRevision).toBe('signed-out-again')
    expect(getOffers).toHaveBeenCalledTimes(3)
  })

  it('fails a dynamic offer refresh closed instead of retaining a stale selectable row', async () => {
    const instance = fakeInstance('ollama')
    instance.getOffers = vi.fn(async () => {
      throw new Error('probe unavailable')
    })
    const registry = new HostNodeProviderRegistry({
      providers: [fakeProvider('ollama', { create: () => instance })],
      runPort,
      interactions
    })

    await registry.refreshOffers('ollama')
    expect(registry.getOffers('ollama')).toMatchObject({ providerId: 'ollama', models: [] })
    expect(registry.getOffers('ollama')?.offerRevision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps guarded AntiGravity out of inventory until live offers exist', async () => {
    const instance = fakeInstance('antigravity')
    instance.getOffers = vi.fn(async () => ({
      providerId: 'antigravity',
      offerRevision: 'live-proof',
      models: [
        {
          modelId: 'gemini-3.7-flash-high',
          label: 'Gemini 3.7 Flash',
          available: true,
          default: true,
          reasoning: []
        }
      ],
      postures: []
    }))
    const conditional = fakeProvider('antigravity', {
      conditionalAdmission: 'antigravity-live-guarded',
      offers: {
        providerId: 'antigravity',
        offerRevision: 'not-admitted',
        models: [],
        postures: []
      },
      create: () => instance
    })
    const registry = new HostNodeProviderRegistry({
      providers: [conditional],
      runPort,
      interactions
    })
    expect(registry.providerInventory()).toEqual([])
    await registry.refreshOffers('antigravity')
    expect(registry.providerInventory()).toEqual([
      expect.objectContaining({
        providerId: 'antigravity',
        modelId: 'gemini-3.7-flash-high'
      })
    ])
  })

  it('aggregates interaction support flags', () => {
    const withCaps = new HostNodeProviderRegistry({
      providers: [
        fakeProvider('muse', { supportsApprovals: true }),
        fakeProvider('claude', { supportsQuestions: true })
      ],
      runPort,
      interactions
    })
    expect(withCaps.supportsApprovals).toBe(true)
    expect(withCaps.supportsQuestions).toBe(true)
  })

  it('derives inventory projection from factory metadata and offers', () => {
    const registry = new HostNodeProviderRegistry({
      providers: [fakeProvider('muse')],
      runPort,
      interactions
    })
    expect(registry.providerInventory()).toEqual([
      {
        providerId: 'muse',
        displayProvider: 'MUSE',
        shortCode: 'MUS',
        available: true,
        modelId: 'muse-model-1',
        modelLabel: 'muse Model'
      }
    ])
  })

  it('projects the flagged default model rather than the first available row', () => {
    const provider = fakeProvider('muse', {
      offers: {
        ...fakeProvider('muse').offers,
        models: [
          { modelId: 'first', label: 'First', available: true, reasoning: [] },
          {
            modelId: 'preferred',
            label: 'Preferred',
            available: true,
            default: true,
            reasoning: []
          }
        ]
      }
    })
    const registry = new HostNodeProviderRegistry({ providers: [provider], runPort, interactions })
    expect(registry.providerInventory()[0]).toMatchObject({
      modelId: 'preferred',
      modelLabel: 'Preferred'
    })
  })

  it('shuts down every instance', async () => {
    const providers = [fakeProvider('muse'), fakeProvider('claude')]
    const registry = new HostNodeProviderRegistry({ providers, runPort, interactions })
    await registry.shutdown()
    const muse = registry.getInstance('muse')!
    const claude = registry.getInstance('claude')!
    expect(muse.shutdown).toHaveBeenCalledOnce()
    expect(claude.shutdown).toHaveBeenCalledOnce()
  })
})

describe('validateHostNodeProviderComposition', () => {
  it('passes only for the exact live set', () => {
    expect(() =>
      validateHostNodeProviderComposition([
        'codex',
        'claude',
        'kimi',
        'cursor',
        'grok',
        'ollama',
        'pi',
        'mistral',
        'muse'
      ])
    ).not.toThrow()
  })

  it('fails for subsets, supersets, or reordered sets', () => {
    expect(() => validateHostNodeProviderComposition(['muse'])).toThrow()
    expect(() =>
      validateHostNodeProviderComposition([
        'codex',
        'claude',
        'kimi',
        'cursor',
        'grok',
        'ollama',
        'pi',
        'mistral',
        'muse',
        'extra'
      ])
    ).toThrow()
  })
})
