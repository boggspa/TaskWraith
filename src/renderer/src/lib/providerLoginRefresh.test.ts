import { describe, expect, it, vi } from 'vitest'
import {
  INTERACTIVE_PROVIDER_LOGIN_REFRESH_DELAYS_MS,
  openInteractiveProviderLogin
} from './providerLoginRefresh'

describe('openInteractiveProviderLogin', () => {
  it('refreshes immediately and schedules bounded background probes after Terminal opens', async () => {
    const refresh = vi.fn()
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []

    await expect(
      openInteractiveProviderLogin('mistral', {
        openTerminal: async () => ({ ok: true }),
        refresh,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs })
          return scheduled.length
        }
      })
    ).resolves.toBe(true)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenLastCalledWith('mistral')
    expect(scheduled.map((entry) => entry.delayMs)).toEqual(
      INTERACTIVE_PROVIDER_LOGIN_REFRESH_DELAYS_MS
    )
    scheduled.forEach((entry) => entry.callback())
    expect(refresh).toHaveBeenCalledTimes(1 + INTERACTIVE_PROVIDER_LOGIN_REFRESH_DELAYS_MS.length)
  })

  it('does not schedule refreshes when the Terminal handoff cannot open', async () => {
    const refresh = vi.fn()
    const schedule = vi.fn()
    const onOpenError = vi.fn()

    await expect(
      openInteractiveProviderLogin('mistral', {
        openTerminal: async () => ({ ok: false, error: 'not installed' }),
        refresh,
        schedule,
        onOpenError
      })
    ).resolves.toBe(false)

    expect(refresh).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
    expect(onOpenError).toHaveBeenCalledWith('not installed')
  })
})
