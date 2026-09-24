import { afterEach, describe, expect, it, vi } from 'vitest'

import * as termination from '../host-client/HostProcessTermination'
import type { HostStopAllHost, HostStopAllReport } from '../host-client/HostStopAll'
import {
  ensureTuiHostAvailable,
  planTuiHostStopAll,
  restartTuiHost,
  runTuiHostStopAll,
  type TuiHostAuthenticatedProbe
} from './hostProcessManager'

const birthIdentity = 'a'.repeat(64)
const startedAt = '2026-09-23T10:00:00.000Z'
const command = {
  executable: '/test/node',
  args: ['/test/host/host-runtime/cli.js', 'serve', '--profile', '/test/profile'],
  cwd: '/test',
  env: {}
}

afterEach(() => vi.restoreAllMocks())

describe('TUI default verified termination', () => {
  it('passes the captured restart identity to verified termination and never sends a bare signal', async () => {
    const stop = vi.spyOn(termination, 'terminateHostProcess').mockResolvedValue({
      kind: 'inconsistent',
      pid: 4242,
      heldBy: 777,
      steps: [],
      swept: []
    })
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('bare signal must never be used')
    })
    const spawn = vi.fn()
    const expected = { pid: 4242, birthIdentity }

    const result = await restartTuiHost({
      profile: 'production',
      userDataPath: '/test/profile',
      registryRoot: '/test/registry',
      expected,
      resolveLaunchCommand: async () => command,
      spawn
    })

    expect(stop).toHaveBeenCalledExactlyOnceWith({
      profilePath: '/test/profile',
      registryRoot: '/test/registry',
      expected
    })
    expect(result.launch).toBeUndefined()
    expect(signal).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('binds automatic stale-payload replacement to the probed pid and start identity', async () => {
    const stop = vi.spyOn(termination, 'terminateHostProcess').mockResolvedValue({
      kind: 'identity_unavailable',
      pid: 4242,
      steps: [],
      swept: []
    })
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('bare signal must never be used')
    })
    const probe = {
      welcome: {},
      process: { pid: 4242, startedAt, payloadVersion: 'old' }
    } as TuiHostAuthenticatedProbe

    const result = await ensureTuiHostAvailable({
      profile: 'production',
      userDataPath: '/test/profile',
      registryRoot: '/test/registry',
      probe: async () => probe,
      resolveLaunchCommand: async () => command,
      resolvePayloadVersion: async () => 'new'
    })

    expect(stop).toHaveBeenCalledExactlyOnceWith({
      profilePath: '/test/profile',
      registryRoot: '/test/registry',
      expected: { pid: 4242, birthIdentity: null, startedAtMs: Date.parse(startedAt) }
    })
    expect(result).toMatchObject({ kind: 'existing', staleHost: { pid: 4242 } })
    expect(signal).not.toHaveBeenCalled()
  })

  it('refuses restart without a captured identity before reading or signalling any process', async () => {
    const stop = vi.spyOn(termination, 'terminateHostProcess')
    const result = await restartTuiHost({
      profile: 'production',
      userDataPath: '/test/profile',
      pid: 4242,
      resolveLaunchCommand: async () => command
    })

    expect(result.termination.kind).toBe('unverifiable')
    expect(result.launch).toBeUndefined()
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(['all', 'payload-root'] as const)(
    'leaves an unlisted replacement untouched when a confirmed %s plan contains a dead Host',
    async (scope) => {
      const row: HostStopAllHost = {
        source: 'registry',
        profilePath: '/test/profile',
        pid: 101,
        birthIdentity,
        cliPath: '/test/host/host-runtime/cli.js',
        payloadVersion: 'old',
        startedAt,
        holders: 0,
        implicitHolders: 0,
        persist: false,
        liveness: 'dead',
        selected: true
      }
      const stopAll = async (): Promise<HostStopAllReport> => ({
        registryRoot: '/test/registry',
        scope: { kind: 'all' },
        scanArgv: false,
        hosts: [row],
        unreadableEntries: [],
        exitCode: 0
      })
      const original = termination.terminateHostProcess
      const shutdown = vi.fn(async () => 'stopping' as const)
      const signal = vi.fn(async () => undefined)
      const stop = vi.spyOn(termination, 'terminateHostProcess').mockImplementation((input) =>
        original({
          ...input,
          ports: {
            readEvidence: () => ({
              discovery: { pid: 202, startedAt, socketPath: '/test/socket' },
              lease: {
                pid: 202,
                processStartIdentity: 'b'.repeat(64),
                processStartedAt: startedAt,
                acquiredAt: startedAt
              },
              registry: { pid: 101, birthIdentity, bootEpoch: null }
            }),
            observe: async (pid) =>
              pid === 101
                ? { state: 'dead' }
                : {
                    state: 'live',
                    birthIdentity: 'b'.repeat(64),
                    startedAtMs: Date.parse(startedAt)
                  },
            shutdown,
            signal,
            sweep: async () => []
          }
        })
      )
      const plan = await planTuiHostStopAll(
        {
          scope:
            scope === 'all' ? { kind: 'all' } : { kind: 'payload-root', payloadRoot: '/test/host' },
          scanArgv: false
        },
        { registryRoot: '/test/registry', ports: { stopAll } }
      )

      const result = await runTuiHostStopAll(plan, { ports: { stopAll } })

      expect(stop).toHaveBeenCalledExactlyOnceWith({
        profilePath: '/test/profile',
        registryRoot: '/test/registry',
        expected: { pid: 101, birthIdentity, startedAtMs: Date.parse(startedAt) }
      })
      expect(result.kind).toBe('done')
      expect(shutdown).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
    }
  )
})
