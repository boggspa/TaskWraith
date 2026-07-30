import { describe, expect, it, vi } from 'vitest'
import {
  createAntigravityRateLimitHandler,
  registerAntigravityRateLimitHandler
} from './AntigravityRateLimitHandler'
import type { AgyDiscoveryProvenance } from './AntigravityAgyDiscoveryProvenance'

describe('registered get-agent-rate-limits AntiGravity handler', () => {
  it('takes the API-only side-effect-free path without an authenticated AGY probe', async () => {
    const resolveBinary = vi.fn()
    const spawnPty = vi.fn()
    const fetchQuota = vi.fn(async (_settings, authenticatedConnection: boolean) => ({
      provider: 'antigravity',
      configured: authenticatedConnection
    }))
    const fetchAuthenticatedQuota = vi.fn(async () => {
      resolveBinary()
      spawnPty()
      throw new Error('authenticated AGY probe must not be reached')
    })
    const handler = createAntigravityRateLimitHandler({
      getSettings: () => ({
        antigravityEnabled: true,
        antigravityOptInAcceptedAt: 1
      } as never),
      statusSnapshot: () => ({
        ready: true,
        configuredProviders: new Set(['antigravity'])
      }),
      modelsSnapshot: () =>
        new Map([
          [
            'antigravity',
            [{ id: 'gemini-api:gemini-2.5-flash', label: 'Gemini API · flash · separate billing' }]
          ]
        ]),
      fetchQuota,
      fetchAuthenticatedQuota
    })
    const registration: {
      listener: ((event: unknown, provider: unknown, options?: { force?: unknown }) => Promise<unknown>) | null
    } = { listener: null }
    registerAntigravityRateLimitHandler(
      {
        handle: (_channel, listener) => {
          registration.listener = listener
        }
      },
      handler,
      async () => null
    )
    const registeredHandler = registration.listener
    if (!registeredHandler) throw new Error('handler was not registered')

    await expect(registeredHandler({}, 'antigravity', { force: true })).resolves.toEqual({
      provider: 'antigravity',
      configured: false
    })
    expect(fetchQuota).toHaveBeenCalledWith(expect.anything(), false, {})
    expect(fetchAuthenticatedQuota).not.toHaveBeenCalled()
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(spawnPty).not.toHaveBeenCalled()
  })

  // Each /usage probe opens a real authenticated agy session, so the gate must
  // rest on evidence that someone signed in — not on the offer existing. The
  // rows below are identical in all three cases; only provenance differs.
  describe('probe gate rests on discovery provenance, not row shape', () => {
    const AGY_ROWS = [{ id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High' }]
    const NOW_MS = Date.parse('2026-07-30T00:00:00.000Z')

    function harness(provenance: AgyDiscoveryProvenance) {
      const fetchQuota = vi.fn(async () => ({ provider: 'antigravity', configured: false }))
      const fetchAuthenticatedQuota = vi.fn(async () => ({
        provider: 'antigravity',
        configured: true
      }))
      const handler = createAntigravityRateLimitHandler({
        getSettings: () =>
          ({ antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }) as never,
        statusSnapshot: () => ({ ready: true, configuredProviders: new Set(['antigravity']) }),
        modelsSnapshot: () => new Map([['antigravity', AGY_ROWS]]) as never,
        fetchQuota,
        fetchAuthenticatedQuota,
        readProvenance: () => provenance,
        nowMs: () => NOW_MS
      })
      return { handler, fetchQuota, fetchAuthenticatedQuota }
    }

    it('permits the probe when a live discovery proved the connection', async () => {
      const { handler, fetchAuthenticatedQuota } = harness({ source: 'live', cachedAtMs: null })
      await handler({ force: true })
      expect(fetchAuthenticatedQuota).toHaveBeenCalledWith(expect.anything(), true)
    })

    it('permits the probe on a cache inside the evidence window', async () => {
      const { handler, fetchAuthenticatedQuota } = harness({
        source: 'cached',
        cachedAtMs: NOW_MS - 24 * 60 * 60 * 1000
      })
      await handler({ force: true })
      expect(fetchAuthenticatedQuota).toHaveBeenCalledWith(expect.anything(), true)
    })

    it('REFUSES the probe on floor rows even with force set', async () => {
      // The exposure reduction: a machine that never authenticated can no
      // longer open an agy session. Under the old shape test this probed.
      const { handler, fetchQuota, fetchAuthenticatedQuota } = harness({
        source: 'floor',
        cachedAtMs: null
      })
      await handler({ force: true })
      expect(fetchAuthenticatedQuota).not.toHaveBeenCalled()
      expect(fetchQuota).toHaveBeenCalledWith(expect.anything(), false, {})
    })

    it('REFUSES the probe on a cache past the evidence window', async () => {
      const { handler, fetchQuota, fetchAuthenticatedQuota } = harness({
        source: 'cached',
        cachedAtMs: NOW_MS - 30 * 24 * 60 * 60 * 1000
      })
      await handler({ force: true })
      expect(fetchAuthenticatedQuota).not.toHaveBeenCalled()
      expect(fetchQuota).toHaveBeenCalledWith(expect.anything(), false, {})
    })
  })
})
