import { describe, expect, it, vi } from 'vitest'

import { captureHostStandaloneAgyModels, type HostNodeAgyPtyLike } from './HostNodeAgyPtyCapture'

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
      '/usr/local/bin/agy',
      ['models'],
      { env: { PATH: '/usr/local/bin' }, timeoutMs: 8_000 },
      { spawnPty }
    )
    child.emitData('gemini-3.7-flash-high\r\n')
    child.emitExit(0)

    await expect(pending).resolves.toEqual({
      stdout: 'gemini-3.7-flash-high\r\n',
      stderr: '',
      code: 0
    })
    expect(spawnPty).toHaveBeenCalledWith('/usr/local/bin/agy', ['models'], {
      env: { PATH: '/usr/local/bin' }
    })
  })

  it('rejects any command shape other than a canonical absolute agy models probe', async () => {
    const spawnPty = vi.fn()
    await expect(
      captureHostStandaloneAgyModels('agy', ['models'], { env: {}, timeoutMs: 8_000 }, { spawnPty })
    ).resolves.toMatchObject({ code: null, error: expect.stringMatching(/invalid/i) })
    await expect(
      captureHostStandaloneAgyModels(
        '/usr/local/bin/agy',
        ['run'],
        { env: {}, timeoutMs: 8_000 },
        { spawnPty }
      )
    ).resolves.toMatchObject({ code: null, error: expect.stringMatching(/invalid/i) })
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('keeps Host startup dependency-light and fails the probe closed when node-pty is absent', async () => {
    await expect(
      captureHostStandaloneAgyModels(
        '/usr/local/bin/agy',
        ['models'],
        { env: {}, timeoutMs: 8_000 },
        { loadPty: () => Promise.reject(new Error('module unavailable')) }
      )
    ).resolves.toEqual({
      stdout: '',
      stderr: '',
      code: null,
      error: 'agy models could not start.'
    })
  })

  it('kills and discards an oversized capture', async () => {
    const child = terminal()
    const pending = captureHostStandaloneAgyModels(
      '/usr/local/bin/agy',
      ['models'],
      { env: {}, timeoutMs: 8_000 },
      { spawnPty: () => child }
    )
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
    const pending = captureHostStandaloneAgyModels(
      '/usr/local/bin/agy',
      ['models'],
      { env: {}, timeoutMs: 8_000 },
      {
        spawnPty: () => child,
        setTimer: (callback) => {
          timers.push(callback)
          return 'timer'
        },
        clearTimer: vi.fn()
      }
    )
    timers[0]?.()
    await expect(pending).resolves.toMatchObject({ timedOut: true, code: null })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
