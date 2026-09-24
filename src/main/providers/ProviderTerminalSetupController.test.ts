import { describe, expect, it, vi } from 'vitest'

import { createProviderTerminalSetupController } from './ProviderTerminalSetupController'

describe('ProviderTerminalSetupController', () => {
  it('binds only catalogued login flows to the deterministic Host operation id', async () => {
    const launch = vi.fn(async () => ({ ok: true }))
    const controller = createProviderTerminalSetupController({ launch })
    await expect(
      controller.begin({ provider: 'codex', flowId: 'codex:login', operationId: 'command-1' })
    ).resolves.toEqual({ provider: 'codex', operationId: 'command-1' })
    expect(launch).toHaveBeenCalledWith('codex', 'login')
    await expect(
      controller.begin({ provider: 'grok', flowId: 'grok:login', operationId: 'command-2' })
    ).rejects.toThrow('unavailable')
  })

  it('preserves IPC compatibility opens and never claims detached terminal cancellation', async () => {
    const launch = vi.fn(async () => ({ ok: false, error: 'legacy explanatory error' }))
    const controller = createProviderTerminalSetupController({ launch })
    await expect(controller.open('grok', 'login')).resolves.toEqual({
      ok: false,
      error: 'legacy explanatory error'
    })
    await expect(
      controller.cancel({ provider: 'codex', operationId: 'command-1' })
    ).resolves.toEqual({
      outcome: 'not_cancellable'
    })
  })
})
