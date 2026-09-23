import { spawn } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import {
  PROCESS_BIRTH_IDENTITY_PATTERN,
  PROCESS_BIRTH_START_TOLERANCE_MS,
  PROCESS_LISTING_MAX_BUFFER_BYTES,
  currentProcessBirthIdentity,
  digestProcessBirth,
  listProcessCommandLines,
  matchProcessBirth,
  observeProcessBirthIdentity,
  observeProcessBirthIdentitySync,
  observeProcessCommandLine,
  parseProcCmdline,
  parsePsLstart,
  parsePsProcessTable,
  parsePsStatLstart,
  parseProcStatBootTimeSeconds,
  parseProcStatStartTicks,
  parseWindowsStartTicks,
  procStatHasExited,
  type ProcessBirthExecOptions
} from './ProcessBirthIdentity'

const LSTART = 'Tue Sep 22 13:43:18 2026'
const LSTART_MS = Date.UTC(2026, 8, 22, 13, 43, 18)

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('ProcessBirthIdentity', () => {
  it('derives the same 64-hex identity for the current process on every observation', () => {
    const first = observeProcessBirthIdentitySync(process.pid)
    const second = observeProcessBirthIdentitySync(process.pid)
    expect(first.state).toBe('live')
    if (first.state !== 'live' || second.state !== 'live') throw new Error('unreachable')
    expect(first.birthIdentity).toMatch(PROCESS_BIRTH_IDENTITY_PATTERN)
    expect(second.birthIdentity).toBe(first.birthIdentity)
    expect(currentProcessBirthIdentity()).toEqual(first)
    // The observed start must agree with Node's own uptime within the
    // tolerance the legacy-lease comparison relies on.
    if (first.startedAtMs !== null) {
      const nodeStart = Date.now() - process.uptime() * 1_000
      expect(Math.abs(first.startedAtMs - nodeStart)).toBeLessThanOrEqual(
        PROCESS_BIRTH_START_TOLERANCE_MS
      )
    }
  })

  it('never probes an invalid pid', () => {
    const processKill = vi.fn()
    for (const pid of [0, 1, -3, 1.5, Number.NaN, 2 ** 53]) {
      expect(observeProcessBirthIdentitySync(pid, { processKill })).toEqual({
        state: 'identity_unavailable'
      })
    }
    expect(processKill).not.toHaveBeenCalled()
  })

  it('runs ps under LC_ALL=C and TZ=UTC on darwin and digests platform, pid and the raw lstart', () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: ProcessBirthExecOptions
    }> = []
    const observation = observeProcessBirthIdentitySync(4242, {
      platform: 'darwin',
      processKill: () => undefined,
      execFileSync: (file, args, options) => {
        calls.push({ file, args, options })
        return `Ss   ${LSTART}    \n`
      }
    })
    expect(calls).toHaveLength(1)
    // @portability-ok: the recorded exec file string (explicit darwin platform,
    // recording execFileSync); nothing runs /bin/ps on the test runner.
    expect(calls[0].file).toBe('/bin/ps')
    expect(calls[0].args).toEqual(['-o', 'stat=,lstart=', '-p', '4242'])
    expect(calls[0].options.env).toEqual({ LC_ALL: 'C', TZ: 'UTC' })
    expect(calls[0].options.timeout).toBe(2_000)
    expect(observation).toEqual({
      state: 'live',
      birthIdentity: digestProcessBirth('darwin', 4242, LSTART),
      startedAtMs: LSTART_MS
    })
  })

  it('reports dead on ESRCH without invoking the platform read', () => {
    const execFileSync = vi.fn()
    expect(
      observeProcessBirthIdentitySync(4242, {
        platform: 'darwin',
        processKill: () => {
          throw errno('ESRCH')
        },
        execFileSync
      })
    ).toEqual({ state: 'dead' })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('reports identity_unavailable on EPERM and never reads the platform birth', () => {
    const execFileSync = vi.fn()
    expect(
      observeProcessBirthIdentitySync(4242, {
        platform: 'darwin',
        processKill: () => {
          throw errno('EPERM')
        },
        execFileSync
      })
    ).toEqual({ state: 'identity_unavailable' })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('reports dead when ps fails and the pid has vanished since the first probe', () => {
    let probes = 0
    expect(
      observeProcessBirthIdentitySync(4242, {
        platform: 'darwin',
        processKill: () => {
          probes += 1
          if (probes > 1) throw errno('ESRCH')
        },
        execFileSync: () => {
          throw new Error('ps: process exited')
        }
      })
    ).toEqual({ state: 'dead' })
    expect(probes).toBe(2)
  })

  it('reports identity_unavailable for a live pid whose lstart is not a C-locale timestamp', () => {
    for (const output of [
      '',
      'S    mar. 22 sept. 13:43:18 2026',
      'S    Tue Sep 22 2026',
      'garbage',
      LSTART
    ]) {
      expect(
        observeProcessBirthIdentitySync(4242, {
          platform: 'darwin',
          processKill: () => undefined,
          execFileSync: () => output
        })
      ).toEqual({ state: 'identity_unavailable' })
    }
  })

  it('binds a linux identity to the boot id and start ticks and derives the start from btime', () => {
    const files = new Map<string, string>([
      ['/proc/sys/kernel/random/boot_id', 'c0ffee00-1234-4321-abcd-000000000001\n'],
      [
        '/proc/4242/stat',
        '4242 (node (host) x) S 1 4242 4242 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 123456 1 2 3\n'
      ],
      ['/proc/stat', 'cpu  1 2 3 4\nbtime 1700000000\nprocesses 5\n']
    ])
    const observation = observeProcessBirthIdentitySync(4242, {
      platform: 'linux',
      processKill: () => undefined,
      readFileSync: (path) => {
        const value = files.get(path)
        if (value === undefined) throw errno('ENOENT')
        return value
      },
      clockTicksPerSecond: 100
    })
    expect(observation).toEqual({
      state: 'live',
      birthIdentity: digestProcessBirth(
        'linux',
        4242,
        'c0ffee00-1234-4321-abcd-000000000001:123456'
      ),
      startedAtMs: 1_700_000_000_000 + 1_234_560
    })
  })

  it('reports identity_unavailable on a malformed /proc stat line', () => {
    const observation = observeProcessBirthIdentitySync(4242, {
      platform: 'linux',
      processKill: () => undefined,
      readFileSync: (path) =>
        path.endsWith('boot_id') ? 'c0ffee00-1234-4321-abcd-000000000001\n' : '4242 node S 1 2 3\n'
    })
    expect(observation).toEqual({ state: 'identity_unavailable' })
  })

  it('reads a zombie as dead from the ps state or the /proc state, never as a live birth', async () => {
    expect(
      observeProcessBirthIdentitySync(4242, {
        platform: 'darwin',
        processKill: () => undefined,
        execFileSync: () => `Z    ${LSTART}\n`
      })
    ).toEqual({ state: 'dead' })
    await expect(
      observeProcessBirthIdentity(4242, {
        platform: 'darwin',
        processKill: () => undefined,
        execFile: async () => `Z+   ${LSTART}\n`
      })
    ).resolves.toEqual({ state: 'dead' })
    const zombieStat =
      '4242 (node) Z 1 4242 4242 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 123456 1 2 3\n'
    const bootId = 'c0ffee00-1234-4321-abcd-000000000001\n'
    expect(
      observeProcessBirthIdentitySync(4242, {
        platform: 'linux',
        processKill: () => undefined,
        readFileSync: (path) => (path.endsWith('boot_id') ? bootId : zombieStat)
      })
    ).toEqual({ state: 'dead' })
    await expect(
      observeProcessBirthIdentity(4242, {
        platform: 'linux',
        processKill: () => undefined,
        readFile: async (path) => (path.endsWith('boot_id') ? bootId : zombieStat)
      })
    ).resolves.toEqual({ state: 'dead' })
    expect(parsePsStatLstart(`Ss   ${LSTART}  \n`)).toEqual({
      zombie: false,
      birth: { raw: LSTART, startedAtMs: LSTART_MS }
    })
    expect(parsePsStatLstart(`Z+   ${LSTART}`)?.zombie).toBe(true)
    expect(parsePsStatLstart('garbage')).toBeNull()
    expect(procStatHasExited(zombieStat)).toBe(true)
    expect(procStatHasExited(zombieStat.replace(' Z ', ' X '))).toBe(true)
    expect(procStatHasExited(zombieStat.replace(' Z ', ' S '))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'reads a real child that has exited but is not yet reaped as dead',
    () => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      const pid = child.pid
      if (pid === undefined) throw new Error('spawn failed')
      // The event loop stays blocked for the whole test, so libuv cannot reap
      // the child: once it exits it stays a zombie until the test returns.
      const deadline = Date.now() + 10_000
      let observation = observeProcessBirthIdentitySync(pid)
      while (observation.state === 'live' && Date.now() < deadline) {
        observation = observeProcessBirthIdentitySync(pid)
      }
      expect(observation).toEqual({ state: 'dead' })
      // Still in the process table: dead because it exited, not because it is gone.
      expect(() => process.kill(pid, 0)).not.toThrow()
    }
  )

  it('reads PowerShell start ticks on win32 through the fixed system PowerShell', () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: ProcessBirthExecOptions
    }> = []
    const ticks = '638_000_000_000_000_000'.replace(/_/g, '')
    const observation = observeProcessBirthIdentitySync(4242, {
      platform: 'win32',
      windowsRoot: 'C:\\Windows',
      processKill: () => undefined,
      execFileSync: (file, args, options) => {
        calls.push({ file, args, options })
        return ticks
      }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toMatch(/WindowsPowerShell/)
    expect(calls[0].file).toMatch(/powershell\.exe$/)
    expect(calls[0].args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command'
    ])
    expect(calls[0].args[4]).toContain('Get-Process -Id 4242')
    // UTC ticks: a local-time start would disagree with the UTC lease stamps.
    expect(calls[0].args[4]).toContain('$p.StartTime.ToUniversalTime().Ticks')
    // PowerShell inherits the environment (SystemRoot and friends); only ps is pinned.
    expect(calls[0].options.env).toBeUndefined()
    expect(observation).toEqual({
      state: 'live',
      birthIdentity: digestProcessBirth('win32', 4242, ticks),
      startedAtMs: Number((BigInt(ticks) - 621_355_968_000_000_000n) / 10_000n)
    })
  })

  it('observes asynchronously with the same classification', async () => {
    await expect(
      observeProcessBirthIdentity(4242, {
        platform: 'darwin',
        processKill: () => undefined,
        execFile: async () => `S    ${LSTART}\n`
      })
    ).resolves.toEqual({
      state: 'live',
      birthIdentity: digestProcessBirth('darwin', 4242, LSTART),
      startedAtMs: LSTART_MS
    })
    let probes = 0
    await expect(
      observeProcessBirthIdentity(4242, {
        platform: 'darwin',
        processKill: () => {
          probes += 1
          if (probes > 1) throw errno('ESRCH')
        },
        execFile: async () => {
          throw new Error('ps failed')
        }
      })
    ).resolves.toEqual({ state: 'dead' })
    await expect(
      observeProcessBirthIdentity(4242, {
        platform: 'darwin',
        processKill: () => {
          throw errno('EPERM')
        },
        execFile: async () => `S    ${LSTART}\n`
      })
    ).resolves.toEqual({ state: 'identity_unavailable' })
  })

  it('parses the C-locale lstart shape, including a space-padded day, and nothing else', () => {
    expect(parsePsLstart('Tue Sep  2 04:05:06 2026\n')).toEqual({
      raw: 'Tue Sep  2 04:05:06 2026',
      startedAtMs: Date.UTC(2026, 8, 2, 4, 5, 6)
    })
    expect(parsePsLstart(`  ${LSTART}   `)).toEqual({ raw: LSTART, startedAtMs: LSTART_MS })
    expect(parsePsLstart('Tue Xyz 22 13:43:18 2026')).toBeNull()
    expect(parsePsLstart('2026-09-22T13:43:18Z')).toBeNull()
    // After the last ')' the state is field 3, so field 22 (starttime) is index 19.
    expect(
      parseProcStatStartTicks('1 (a) b) S 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 777 23')
    ).toBe('777')
    expect(parseProcStatStartTicks('no parenthesis')).toBeNull()
    expect(parseProcStatBootTimeSeconds('cpu 1\nbtime 42\n')).toBe(42)
    expect(parseProcStatBootTimeSeconds('cpu 1\n')).toBeNull()
    expect(parseWindowsStartTicks('0')).toBeNull()
    expect(parseWindowsStartTicks('abc')).toBeNull()
    expect(parseWindowsStartTicks('621355968000010000')).toEqual({
      raw: '621355968000010000',
      startedAtMs: 1
    })
  })

  it('pins the digest recipe that Hosts and clients from different releases must share', () => {
    // sha256("darwin" NUL "4242" NUL lstart), computed independently of the module.
    expect(digestProcessBirth('darwin', 4242, LSTART)).toBe(
      '7bf9498c4420bab477f959fcd8ee7d11101b1b006965062404002a0e90b31c43'
    )
  })

  it('matches a digest exactly, a legacy record by start instant, and refuses otherwise', () => {
    const live = { state: 'live', birthIdentity: 'a'.repeat(64), startedAtMs: 10_000 } as const
    expect(matchProcessBirth(live, { birthIdentity: 'a'.repeat(64) })).toBe('match')
    expect(matchProcessBirth(live, { birthIdentity: 'b'.repeat(64) })).toBe('mismatch')
    // A digest expectation wins even when a start instant is also present.
    expect(matchProcessBirth(live, { birthIdentity: 'b'.repeat(64), startedAtMs: 10_000 })).toBe(
      'mismatch'
    )
    expect(matchProcessBirth(live, { birthIdentity: 'node:4242:1a2b', startedAtMs: 11_900 })).toBe(
      'match'
    )
    expect(matchProcessBirth(live, { startedAtMs: 12_001 })).toBe('mismatch')
    expect(matchProcessBirth(live, { birthIdentity: null })).toBe('unverifiable')
    expect(matchProcessBirth({ ...live, startedAtMs: null }, { startedAtMs: 10_000 })).toBe(
      'unverifiable'
    )
    expect(matchProcessBirth({ state: 'dead' }, { birthIdentity: 'a'.repeat(64) })).toBe(
      'unverifiable'
    )
    expect(
      matchProcessBirth({ state: 'identity_unavailable' }, { birthIdentity: 'a'.repeat(64) })
    ).toBe('unverifiable')
  })

  it('reads the command line of the current process', async () => {
    const observation = await observeProcessCommandLine(process.pid)
    expect(observation.state).toBe('live')
    if (observation.state !== 'live') throw new Error('unreachable')
    expect(observation.commandLine.length).toBeGreaterThan(0)
    expect(observation.commandLine).toMatch(/node/i)
  })

  // Every platform branch below is driven with an explicit platform and
  // recording ports; nothing runs ps, /proc or PowerShell on the test runner.
  it('reads a command line per platform under the birth observer existence rules', async () => {
    const execCalls: Array<{
      file: string
      args: readonly string[]
      options: ProcessBirthExecOptions
    }> = []
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'darwin',
        processKill: () => undefined,
        execFile: async (file, args, options) => {
          execCalls.push({ file, args, options })
          return '/usr/bin/node /x/out/host/host-runtime/cli.js serve --profile /p q  \n'
        }
      })
    ).resolves.toEqual({
      state: 'live',
      commandLine: '/usr/bin/node /x/out/host/host-runtime/cli.js serve --profile /p q',
      argv: null
    })
    // @portability-ok: the recorded exec file string, not a path on this runner.
    expect(execCalls[0].file).toBe('/bin/ps')
    expect(execCalls[0].args).toEqual(['-o', 'command=', '-p', '4242'])
    expect(execCalls[0].options.env).toEqual({ LC_ALL: 'C', TZ: 'UTC' })

    const nul = String.fromCharCode(0)
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'linux',
        processKill: () => undefined,
        readFile: async (path) => {
          expect(path).toBe('/proc/4242/cmdline')
          return ['node', '/x/cli.js', 'serve', '--profile', '/p q', ''].join(nul)
        }
      })
    ).resolves.toEqual({
      state: 'live',
      commandLine: 'node /x/cli.js serve --profile /p q',
      argv: ['node', '/x/cli.js', 'serve', '--profile', '/p q']
    })

    const winCalls: Array<{ args: readonly string[]; options: ProcessBirthExecOptions }> = []
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'win32',
        windowsRoot: 'C:\\Windows',
        processKill: () => undefined,
        execFile: async (_file, args, options) => {
          winCalls.push({ args, options })
          return '"C:\\node.exe" "C:\\host\\host-runtime\\cli.js" serve --profile "C:\\p"'
        }
      })
    ).resolves.toMatchObject({ state: 'live', argv: null })
    expect(winCalls[0].args[4]).toContain('Win32_Process')
    expect(winCalls[0].args[4]).toContain('ProcessId = 4242')
    expect(winCalls[0].options.env).toBeUndefined()

    await expect(
      observeProcessCommandLine(4242, {
        platform: 'darwin',
        processKill: () => {
          throw errno('ESRCH')
        },
        execFile: async () => 'never read'
      })
    ).resolves.toEqual({ state: 'dead' })
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'darwin',
        processKill: () => {
          throw errno('EPERM')
        },
        execFile: async () => 'never read'
      })
    ).resolves.toEqual({ state: 'identity_unavailable' })
    let probes = 0
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'darwin',
        processKill: () => {
          probes += 1
          if (probes > 1) throw errno('ESRCH')
        },
        execFile: async () => {
          throw new Error('ps failed')
        }
      })
    ).resolves.toEqual({ state: 'dead' })
    await expect(
      observeProcessCommandLine(4242, {
        platform: 'darwin',
        processKill: () => undefined,
        execFile: async () => '   \n'
      })
    ).resolves.toEqual({ state: 'identity_unavailable' })
  })

  it('lists the process table from one pinned-locale ps call, and not on win32', async () => {
    const calls: Array<{ args: readonly string[]; options: ProcessBirthExecOptions }> = []
    const listing = await listProcessCommandLines({
      platform: 'darwin',
      execFile: async (_file, args, options) => {
        calls.push({ args, options })
        return '    1 /sbin/launchd\n  361 /usr/libexec/logd\n 4242 node cli.js serve --profile /a b \n\n'
      }
    })
    expect(calls[0].args).toEqual(['-axo', 'pid=,command='])
    expect(calls[0].options.env).toEqual({ LC_ALL: 'C', TZ: 'UTC' })
    expect(calls[0].options.maxBuffer).toBe(PROCESS_LISTING_MAX_BUFFER_BYTES)
    expect(listing).toEqual({
      ok: true,
      processes: [
        { pid: 361, commandLine: '/usr/libexec/logd' },
        { pid: 4242, commandLine: 'node cli.js serve --profile /a b' }
      ]
    })
    await expect(
      listProcessCommandLines({
        platform: 'linux',
        execFile: async () => {
          throw new Error('ps missing')
        }
      })
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(listProcessCommandLines({ platform: 'win32' })).resolves.toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(parsePsProcessTable('garbage\n12x y\n')).toEqual([])
    expect(parseProcCmdline('')).toBeNull()
  })
})
