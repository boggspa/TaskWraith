import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyHostSnapshot, type HostSnapshot } from '../shared/hostProtocol'

const run = vi.hoisted(() => ({
  calls: [] as string[],
  snapshot: null as HostSnapshot | null,
  connectError: null as Error | null,
  declineError: null as Error | null,
  snapshotError: null as Error | null,
  ensure: vi.fn(),
  closed: false
}))

vi.mock('../host-client/HostProjectionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-client/HostProjectionClient')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    HostProjectionClient: class extends EventEmitter {
      async connect() {
        run.calls.push('connect')
        if (run.connectError) throw run.connectError
        const welcome = { hostVersion: 'test-host' }
        this.emit('welcome', welcome)
        run.calls.push('connect-resolved')
        return welcome
      }
      async declineHostLease() {
        run.calls.push('decline')
        if (run.declineError) throw run.declineError
      }
      async getSnapshot() {
        run.calls.push('snapshot')
        if (run.snapshotError) throw run.snapshotError
        return { snapshot: run.snapshot }
      }
      close() {
        run.calls.push('close')
        run.closed = true
      }
    }
  }
})

vi.mock('./hostProcessManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hostProcessManager')>()),
  ensureTuiHostAvailable: run.ensure
}))

vi.mock('./settings', () => ({
  readTuiSettings: () => ({}),
  readTuiProfileSettings: () => ({}),
  writeTuiSettings: vi.fn(),
  writeTuiProfileSettings: vi.fn()
}))

const originalExitCode = process.exitCode
const originalArgs = process.argv
let output: string[]
let errors: string[]

beforeEach(() => {
  vi.resetModules()
  run.calls.length = 0
  run.connectError = null
  run.declineError = null
  run.snapshotError = null
  run.closed = false
  run.ensure.mockReset()
  run.snapshot = createEmptyHostSnapshot({
    generation: 3,
    cursor: 7,
    generatedAt: '2026-09-24T00:00:00.000Z'
  })
  output = []
  errors = []
  process.exitCode = undefined
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
  // Entry-point lifecycle registration must not replace the test runner's handlers.
  vi.spyOn(process, 'on').mockReturnValue(process)
  vi.spyOn(process, 'once').mockReturnValue(process)
})

afterEach(() => {
  process.exitCode = originalExitCode
  process.argv = originalArgs
  vi.restoreAllMocks()
})

async function invoke(mode: '--json' | '--snapshot'): Promise<void> {
  process.argv = [
    'node',
    'tui',
    mode,
    '--ascii',
    '--color=none',
    '--theme=oxide',
    '--width=80',
    '--height=24'
  ]
  await import('./cli')
  await vi.waitFor(() => expect(output.length + errors.length).toBeGreaterThan(0))
}

describe('TUI one-shot readers', () => {
  it.each(['--json', '--snapshot'] as const)(
    'declines during welcome and never launches for %s',
    async (mode) => {
      await invoke(mode)

      expect(run.calls).toEqual(['connect', 'decline', 'connect-resolved', 'snapshot', 'close'])
      expect(run.ensure).not.toHaveBeenCalled()
      expect(errors).toEqual([])
      expect(process.exitCode).toBeUndefined()
      if (mode === '--json') {
        expect(JSON.parse(output.join(''))).toEqual({
          schemaVersion: 1,
          source: 'host',
          hostVersion: 'test-host',
          generation: 3,
          cursor: 7,
          freshness: run.snapshot?.freshness,
          snapshot: run.snapshot
        })
      } else {
        expect(output.join('')).toContain('TaskWraith')
        expect(output.join('')).toContain('connected')
      }
    }
  )

  it.each(['--json', '--snapshot'] as const)(
    'reports an idle profile without launching for %s',
    async (mode) => {
      run.connectError = new Error('Host is offline')
      await invoke(mode)

      expect(run.calls).toEqual(['connect', 'close'])
      expect(run.ensure).not.toHaveBeenCalled()
      expect(output).toEqual([])
      expect(errors.join('')).toBe('TaskWraith TUI: Host is offline\n')
      expect(process.exitCode).toBe(1)
    }
  )

  it('keeps the legacy Host projection when lease decline is unsupported', async () => {
    const { HostProjectionTransportError } = await import('../host-client/HostProjectionClient')
    run.declineError = new HostProjectionTransportError('unknown_request_kind')
    await invoke('--json')

    expect(errors).toEqual([])
    expect(JSON.parse(output.join('')).snapshot).toEqual(run.snapshot)
    expect(run.calls).toContain('close')
  })

  it('closes a declined connection even when snapshot retrieval fails', async () => {
    run.snapshotError = new Error('snapshot failed')
    await invoke('--json')

    expect(run.calls).toEqual(['connect', 'decline', 'connect-resolved', 'snapshot', 'close'])
    expect(output).toEqual([])
    expect(errors.join('')).toContain('snapshot failed')
  })

  it('closes immediately when lease decline fails for a current Host', async () => {
    run.declineError = new Error('lease decline failed')
    await invoke('--json')

    expect(run.calls).toEqual(['connect', 'decline', 'connect-resolved', 'close'])
    expect(output).toEqual([])
    expect(errors.join('')).toContain('lease decline failed')
  })
})
