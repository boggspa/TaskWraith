import { describe, expect, it, vi } from 'vitest'
import {
  createAntigravityRateLimitHandler,
  registerAntigravityRateLimitHandler
} from './AntigravityRateLimitHandler'

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
})
