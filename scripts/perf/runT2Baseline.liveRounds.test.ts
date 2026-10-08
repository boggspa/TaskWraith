import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { claimsAuthoritativeBaseline, runT2BaselineCli } = require('./runT2Baseline.cjs') as {
  claimsAuthoritativeBaseline: (input: {
    skipBuild: boolean
    provenanceAuthoritative: unknown
    liveRounds: boolean
  }) => boolean
  runT2BaselineCli: (argv: string[], options: Record<string, unknown>) => Promise<unknown>
}

type DaemonStop = {
  exit: { code: number | null; signal: string | null } | null
  forced: boolean
  summary: unknown
  stderrTail: string
}

const repoRoot = path.resolve(__dirname, '..', '..')
const PROVENANCE = {
  gitSha: 'a'.repeat(40),
  dirty: false,
  dirtyTreeFingerprint: 'b'.repeat(64),
  dirtyPaths: [],
  isolatedWorktree: true,
  authoritativeBaseline: true
}
const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function artifactDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-t2-live-'))
  temporaryPaths.push(dir)
  return dir
}

// The Host bundle preflight reads a fresh bundle without touching out/host.
function freshHostBundleFs() {
  const bundleSuffix = ['out', 'host', 'host-runtime', 'cli.js'].join(path.sep)
  return {
    statSync: (target: string) => ({
      isFile: () => true,
      mtimeMs: String(target).endsWith(bundleSuffix) ? 1e12 : 1
    }),
    readdirSync: () => [{ name: 'Fresh.ts', isFile: () => true, isDirectory: () => false }],
    readFileSync: (target: string) => {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    }
  }
}

function dryRun(extra: string[], options: Record<string, unknown> = {}) {
  return runT2BaselineCli(['--dry-run', `--artifact-dir=${artifactDir()}`, ...extra], {
    repoRoot,
    provenance: PROVENANCE,
    ...options
  })
}

describe('runT2Baseline --live-rounds refusals', () => {
  it('pairs a live-round workload with --live-rounds, both ways', async () => {
    await expect(dryRun(['--workload=light_beside_large_live'])).rejects.toMatchObject({
      code: 'T2_LIVE_ROUNDS_WORKLOAD',
      message: expect.stringMatching(/pass --live-rounds/)
    })
    await expect(dryRun(['--workload=light_beside_large', '--live-rounds'])).rejects.toMatchObject({
      code: 'T2_LIVE_ROUNDS_WORKLOAD',
      message: expect.stringMatching(/replay workload/)
    })
  })

  it.each([['--windowed-replay'], ['--max-replay-events=5'], ['--role=light-alone']])(
    'refuses %s before anything reads a replay schedule',
    async (flag) => {
      await expect(
        dryRun(['--workload=light_beside_large_live', '--live-rounds', flag])
      ).rejects.toMatchObject({ code: 'T2_LIVE_ROUNDS_MODE' })
    }
  )

  it('never lets a live-round run claim an authoritative baseline', () => {
    const claim = (skipBuild: boolean, provenanceAuthoritative: unknown, liveRounds: boolean) =>
      claimsAuthoritativeBaseline({ skipBuild, provenanceAuthoritative, liveRounds })
    expect(claim(false, true, false)).toBe(true)
    expect(claim(false, true, true)).toBe(false)
    expect(claim(true, true, false)).toBe(false)
    expect(claim(false, false, false)).toBe(false)
  })

  it('starts no daemon for a dry run', async () => {
    const starts: unknown[] = []
    await expect(
      dryRun(['--workload=light_beside_large_live', '--live-rounds'], {
        startScriptedDaemon: async (input: unknown) => {
          starts.push(input)
          throw new Error('a dry run must not start the daemon')
        }
      })
    ).resolves.toMatchObject({ ok: true, dryRun: true, launched: false })
    expect(starts).toEqual([])
  })
})

const LIVE_ARGS = ['--workload=light_beside_large_live', '--live-rounds']

describe.skipIf(process.platform === 'win32')('POSIX live-rounds launch', () => {
  const CLEAN_STOP: DaemonStop = {
    exit: { code: 0, signal: null },
    forced: false,
    summary: { schemaVersion: 1 },
    stderrTail: ''
  }

  async function launchLive(stopResult: DaemonStop, workloadArgs = LIVE_ARGS) {
    const events: string[] = []
    const spawnEnvs: Array<Record<string, string | undefined>> = []
    const daemonStarts: Array<{ dir: string; config: unknown }> = []
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-live-'))
    temporaryPaths.push(home)
    const artifacts = artifactDir()
    const failure = (await runT2BaselineCli(
      [
        ...workloadArgs,
        '--launch',
        '--accept-unfolded-cross-thread',
        '--i-accept-isolated-launch',
        '--materialize-instance-userdata',
        '--lean',
        '--instance-id=perfLive01',
        `--home=${home}`,
        `--artifact-dir=${artifacts}`,
        '--port=9413',
        '--inspect-port=9813'
      ],
      {
        repoRoot,
        forceIsolated: true,
        allowDirtyLaunch: true,
        allowNonIsolatedLaunch: true,
        platform: 'darwin',
        provenance: PROVENANCE,
        // The disk preflight is not under test; the Mac's free space must not decide it.
        minFreeDiskBytes: 0,
        env: { ...process.env, OLLAMA_API_KEY: 'operator-key' },
        startScriptedDaemon: async (input: { dir: string; config: unknown }) => {
          daemonStarts.push(input)
          events.push('daemon.start')
          return {
            pid: 7777,
            baseUrl: 'http://127.0.0.1:43999',
            stop: async () => {
              events.push('daemon.stop')
              return stopResult
            }
          }
        },
        buildAdapters: { build: async () => ({ code: 0 }) },
        hostBundleAdapters: { fs: freshHostBundleFs() },
        externalHostAdapters: { exists: () => true },
        spawnAdapters: {
          resolveElectronPath: () => '/virtual/Electron',
          spawn: (_command: string, _args: string[], spawnOptions: { env: never }) => {
            spawnEnvs.push(spawnOptions.env)
            events.push('child.spawn')
            const child = new EventEmitter()
            return Object.assign(child, {
              pid: 9191,
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
              kill(signal: string) {
                events.push(`child.${signal}`)
                queueMicrotask(() => child.emit('exit', 0, signal))
                return true
              }
            })
          }
        },
        portAdapters: {
          probePort: async (port: number) => ({ port, occupied: false }),
          probeCdp: async () => ({ port: 9413, reachable: false }),
          listInstancePids: () => []
        },
        portOwnershipAdapters: {
          listPortPids: async () => [9191],
          timeoutMs: 1000,
          initialDelayMs: 0,
          sleep: async () => {}
        },
        cdpAdapters: {
          httpGetJson: async () => {
            throw new Error('staged attach failure')
          },
          timeoutMs: 0
        },
        terminateOptions: {
          waitMs: 20,
          sleep: async () => {},
          killProcessGroup: (_pgid: number, signal: string) => {
            events.push(`child.${signal}`)
          }
        }
      }
    ).then(
      () => null,
      (error: unknown) => error
    )) as (Error & { cleanupFailures?: Array<{ phase: string; error: string }> }) | null
    return { failure, events, spawnEnvs, daemonStarts, home, artifacts }
  }

  function settingsUnder(root: string): unknown[] {
    const found: unknown[] = []
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'settings.json') {
        found.push(JSON.parse(readFileSync(path.join(entry.parentPath, entry.name), 'utf8')))
      }
    }
    return found
  }

  it('points the profile at the daemon, blanks operator Ollama variables, and stops the daemon after the app', async () => {
    const { failure, events, spawnEnvs, daemonStarts, home, artifacts } =
      await launchLive(CLEAN_STOP)
    expect(failure?.message).toMatch(/staged attach failure/)
    expect(failure?.cleanupFailures ?? []).toEqual([])

    expect(daemonStarts).toEqual([
      {
        dir: path.join(artifacts, 'scripted-ollama'),
        config: {
          seed: 42,
          models: [{ name: 'scripted-llama:latest' }, { name: 'scripted-llama:heavy' }]
        }
      }
    ])
    expect(settingsUnder(home)).toEqual([
      { ollamaBaseUrl: 'http://127.0.0.1:43999', ollamaDefaultModel: 'scripted-llama:latest' }
    ])
    expect(spawnEnvs).toHaveLength(1)
    expect(spawnEnvs[0]).toMatchObject({ OLLAMA_API_KEY: '', OLLAMA_MAX_LOADED_MODELS: '' })

    // The daemon starts before the app and stops once, after the app is down.
    expect(events[0]).toBe('daemon.start')
    expect(events.indexOf('child.spawn')).toBeGreaterThan(0)
    expect(events.filter((event) => event === 'daemon.stop')).toHaveLength(1)
    expect(events.at(-1)).toBe('daemon.stop')
    expect(events.indexOf('child.SIGTERM')).toBeGreaterThan(events.indexOf('child.spawn'))
  })

  it.each([
    [
      'had to be killed',
      { ...CLEAN_STOP, exit: { code: null, signal: 'SIGKILL' }, forced: true },
      ['scripted Ollama daemon ignored SIGTERM and was killed']
    ],
    [
      'crashed without a summary',
      { ...CLEAN_STOP, exit: { code: 1, signal: null }, summary: null },
      [
        'scripted Ollama daemon exited with code 1 (signal null)',
        'scripted Ollama daemon wrote no summary'
      ]
    ]
  ])('reports a daemon that %s as a cleanup failure', async (_label, stopResult, errors) => {
    const { failure } = await launchLive(stopResult as DaemonStop)
    expect(failure?.message).toMatch(/staged attach failure/)
    expect(failure?.cleanupFailures).toEqual(
      errors.map((error) => ({ phase: 'liveDaemon.stop', error }))
    )
  })

  it('blanks operator Ollama variables for a replay launch too, and starts no daemon', async () => {
    const { failure, events, spawnEnvs, daemonStarts } = await launchLive(CLEAN_STOP, [
      '--workload=dual_run',
      '--scale-down=40'
    ])
    expect(failure?.message).toMatch(/staged attach failure/)
    expect(daemonStarts).toEqual([])
    expect(events).not.toContain('daemon.stop')
    expect(spawnEnvs).toHaveLength(1)
    expect(spawnEnvs[0]).toMatchObject({ OLLAMA_API_KEY: '', OLLAMA_MAX_LOADED_MODELS: '' })
  })
})
