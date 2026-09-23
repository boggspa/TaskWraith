import { describe, expect, it, vi } from 'vitest'

import { captureHostStandaloneAgyModels, type HostNodeAgyPtyLike } from './HostNodeAgyPtyCapture'

/**
 * The probe validates the binary with the ambient platform's absolute-path
 * rules (`isAbsolute` + `resolve`), so the fixture must be canonical on the
 * runner's OS. `spawnPty` is mocked — the binary is never executed.
 */
const AGY_BINARY =
  process.platform === 'win32' ? 'C:\\taskwraith-test-bin\\agy.exe' : '/usr/local/bin/agy'
const HELD = { env: {}, timeoutMs: 8_000, consentHeld: () => true }
const NOT_STARTED = {
  stdout: '',
  stderr: '',
  code: null,
  error: 'agy models was not started because AntiGravity consent was withdrawn.'
}

function terminal() {
  let dataListener: ((data: string) => void) | null = null
  let exitListener: ((event: { exitCode: number }) => void) | null = null
  const value: HostNodeAgyPtyLike & {
    emitData(data: string): void
    emitExit(exitCode: number): void
  } = {
    onData: (listener) => {
      dataListener = listener
    },
    onExit: (listener) => {
      exitListener = listener
    },
    kill: vi.fn(),
    emitData: (data) => dataListener?.(data),
    emitExit: (exitCode) => exitListener?.({ exitCode })
  }
  return value
}

describe('captureHostStandaloneAgyModels', () => {
  it('spawns only the exact agy models PTY and returns its bounded output', async () => {
    const child = terminal()
    const spawnPty = vi.fn(() => child)
    const pending = captureHostStandaloneAgyModels(
      AGY_BINARY,
      ['models'],
      { env: { PATH: '/usr/local/bin' }, timeoutMs: 8_000, consentHeld: () => true },
      { spawnPty }
    )
    child.emitData('gemini-3.7-flash-high\r\n')
    child.emitExit(0)

    await expect(pending).resolves.toEqual({
      stdout: 'gemini-3.7-flash-high\r\n',
      stderr: '',
      code: 0
    })
    expect(spawnPty).toHaveBeenCalledWith(AGY_BINARY, ['models'], {
      env: { PATH: '/usr/local/bin' }
    })
  })

  it('rejects any command shape other than a canonical absolute agy models probe', async () => {
    const spawnPty = vi.fn()
    await expect(
      captureHostStandaloneAgyModels('agy', ['models'], HELD, { spawnPty })
    ).resolves.toMatchObject({ code: null, error: expect.stringMatching(/invalid/i) })
    await expect(
      captureHostStandaloneAgyModels(AGY_BINARY, ['run'], HELD, { spawnPty })
    ).resolves.toMatchObject({ code: null, error: expect.stringMatching(/invalid/i) })
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('keeps Host startup dependency-light and fails the probe closed when node-pty is absent', async () => {
    await expect(
      captureHostStandaloneAgyModels(AGY_BINARY, ['models'], HELD, {
        loadPty: () => Promise.reject(new Error('module unavailable'))
      })
    ).resolves.toEqual({
      stdout: '',
      stderr: '',
      code: null,
      error: 'agy models could not start.'
    })
  })

  it('kills and discards an oversized capture', async () => {
    const child = terminal()
    const pending = captureHostStandaloneAgyModels(AGY_BINARY, ['models'], HELD, {
      spawnPty: () => child
    })
    child.emitData('x'.repeat(256 * 1024 + 1))
    await expect(pending).resolves.toMatchObject({
      stdout: '',
      code: null,
      error: expect.stringMatching(/bounded capture limit/i)
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('times out and kills a silent PTY', async () => {
    const child = terminal()
    const timers: Array<() => void> = []
    const pending = captureHostStandaloneAgyModels(AGY_BINARY, ['models'], HELD, {
      spawnPty: () => child,
      setTimer: (callback) => {
        timers.push(callback)
        return 'timer'
      },
      clearTimer: vi.fn()
    })
    timers[0]?.()
    await expect(pending).resolves.toMatchObject({ timedOut: true, code: null })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  // Loading node-pty waits, and consent can be withdrawn meanwhile.
  it('reads consent after node-pty loads, and starts nothing once it is withdrawn', async () => {
    let consent = true
    const spawn = vi.fn()
    await expect(
      captureHostStandaloneAgyModels(
        AGY_BINARY,
        ['models'],
        { env: {}, timeoutMs: 8_000, consentHeld: () => consent },
        {
          loadPty: async () => {
            consent = false
            return { spawn }
          }
        }
      )
    ).resolves.toEqual(NOT_STARTED)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads consent before an injected PTY spawn as well', async () => {
    const spawnPty = vi.fn()
    await expect(
      captureHostStandaloneAgyModels(
        AGY_BINARY,
        ['models'],
        { env: {}, timeoutMs: 8_000, consentHeld: () => false },
        { spawnPty }
      )
    ).resolves.toEqual(NOT_STARTED)
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('starts nothing for a caller that passes no consent check', async () => {
    const spawnPty = vi.fn()
    const noCheck = { env: {}, timeoutMs: 8_000 } as unknown as typeof HELD
    await expect(
      captureHostStandaloneAgyModels(AGY_BINARY, ['models'], noCheck, { spawnPty })
    ).resolves.toEqual(NOT_STARTED)
    expect(spawnPty).not.toHaveBeenCalled()
  })

  // A read that queues a microtask shows whether anything was awaited before
  // the spawn: the spawn must come before that microtask runs.
  it('starts agy models in the same synchronous stretch as its last consent read', async () => {
    const order: string[] = []
    const child = terminal()
    const pending = captureHostStandaloneAgyModels(
      AGY_BINARY,
      ['models'],
      {
        env: {},
        timeoutMs: 8_000,
        consentHeld: () => {
          order.push('consent read')
          queueMicrotask(() => order.push('microtask after the read'))
          return true
        }
      },
      {
        loadPty: async () => ({
          spawn: () => {
            order.push('spawn')
            return child
          }
        })
      }
    )
    await vi.waitFor(() => expect(order).toContain('spawn'))
    child.emitExit(0)
    await pending

    expect(order).toEqual(['consent read', 'spawn', 'microtask after the read'])
  })
})
