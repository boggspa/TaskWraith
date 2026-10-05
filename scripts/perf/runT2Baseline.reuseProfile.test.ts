import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { runT2BaselineCli } = require('./runT2Baseline.cjs') as {
  runT2BaselineCli: (argv: string[], options: Record<string, unknown>) => Promise<unknown>
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

/**
 * Every directory this file makes is named so, directly in the temporary
 * folder or, for an isolated home the launch must find there, in the
 * checkout's perf-homes.
 */
const MADE_PREFIX = 'harness-reuse-'
const made: Array<{ dir: string; root: string }> = []

/** A fresh directory of this file's own in `root`, removed after the test. */
function makeDirectory(root: string): string {
  const dir = mkdtempSync(path.join(root, MADE_PREFIX))
  made.push({ dir, root })
  return dir
}

/** Removes a directory only when it is one this file made: never the folder above it. */
function removeMade(dir: string, root: string) {
  const roots = [tmpdir(), path.join(repoRoot, 'perf-homes')]
  if (
    !roots.includes(root) ||
    dir === root ||
    path.resolve(dir) !== dir ||
    !dir.startsWith(root + path.sep + MADE_PREFIX)
  ) {
    throw new Error(`refusing to remove ${dir}: not a directory this file made`)
  }
  rmSync(dir, { recursive: true, force: true })
}

afterEach(() => {
  while (made.length > 0) {
    const { dir, root } = made.pop()!
    removeMade(dir, root)
  }
})

function makeHome(): string {
  const homesRoot = path.join(repoRoot, 'perf-homes')
  mkdirSync(homesRoot, { recursive: true })
  return makeDirectory(homesRoot)
}

const INSTANCE = 'perfReuse01'
const profileOf = (home: string) =>
  path.join(home, 'Library', 'Application Support', `TaskWraith Dev ${INSTANCE}`)

/** Every file under `dir` with a digest of its bytes, by its path inside `dir`. */
function digestTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else
        out[path.relative(dir, full)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex')
    }
  }
  walk(dir)
  return out
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

/** A CDP socket (renderer or main) that answers every call with an empty result. */
class QuietCdpSocket {
  handlers: Record<string, (...args: unknown[]) => void> = {}
  url: string
  constructor(url: string) {
    this.url = url
    queueMicrotask(() => this.handlers.open && this.handlers.open())
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers[event] = handler
  }
  send(data: string) {
    const message = JSON.parse(data)
    queueMicrotask(() => this.handlers.message(JSON.stringify({ id: message.id, result: {} })))
  }
  close() {
    // Nothing to release.
  }
}

type PhaseCall = { priorRounds: Array<Record<string, unknown>>; threads: unknown[] }

/**
 * One launch whose child, sockets and isolation proof are fakes, so the run
 * reaches the live-round block as a real one does. The smoke's rounds and
 * the many-agent phase are the seams; the capture phases after the phase
 * are skipped by a spent budget, as a real overrun would skip them.
 */
async function launch(home: string, args: string[], withPhase = true) {
  const artifacts = makeDirectory(tmpdir())
  const phaseCalls: PhaseCall[] = []
  const roundCalls: Array<{ prompt: string; chatId: string }> = []
  const daemonStarts: unknown[] = []
  const outcome = await runT2BaselineCli(
    [
      '--workload=many_agents_live',
      '--live-agents',
      '--agent-threads=2',
      '--agent-seats=2',
      '--launch',
      '--accept-unfolded-cross-thread',
      '--i-accept-isolated-launch',
      '--lean',
      `--instance-id=${INSTANCE}`,
      `--home=${home}`,
      `--artifact-dir=${artifacts}`,
      '--port=9417',
      '--inspect-port=9817',
      ...args
    ],
    {
      repoRoot,
      forceIsolated: true,
      allowDirtyLaunch: true,
      allowNonIsolatedLaunch: true,
      platform: 'darwin',
      provenance: PROVENANCE,
      minFreeDiskBytes: 0,
      progressLog: () => {},
      maxCapturePhaseMs: 0,
      env: { ...process.env },
      startScriptedDaemon: async (input: unknown) => {
        daemonStarts.push(input)
        return {
          pid: 7780,
          baseUrl: 'http://127.0.0.1:9',
          stop: async () => ({
            exit: { code: 0, signal: null },
            forced: false,
            summary: { schemaVersion: 1 },
            stderrTail: ''
          })
        }
      },
      buildAdapters: { build: async () => ({ code: 0 }) },
      hostBundleAdapters: { fs: freshHostBundleFs() },
      externalHostAdapters: { exists: () => true },
      spawnAdapters: {
        resolveElectronPath: () => '/virtual/Electron',
        spawn: () => {
          const child = new EventEmitter()
          return Object.assign(child, {
            pid: 9294,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill(signal: string) {
              queueMicrotask(() => child.emit('exit', 0, signal))
              return true
            }
          })
        }
      },
      portAdapters: {
        probePort: async (port: number) => ({ port, occupied: false }),
        probeCdp: async () => ({ port: 9417, reachable: false }),
        listInstancePids: () => []
      },
      portOwnershipAdapters: {
        listPortPids: async () => [9294],
        timeoutMs: 1000,
        initialDelayMs: 0,
        sleep: async () => {}
      },
      mainInspectorUrl: 'ws://127.0.0.1:9817/main',
      WebSocket: QuietCdpSocket,
      cdpAdapters: {
        httpGetJson: async (url: string) =>
          String(url).includes('/json/version')
            ? { Browser: 'Fake/1' }
            : [
                {
                  type: 'page',
                  id: 'p1',
                  webSocketDebuggerUrl: 'ws://127.0.0.1:9417/devtools/page/p1'
                }
              ],
        timeoutMs: 0
      },
      verifyIsolatedHomeAndUserData: async (
        _inspector: unknown,
        expected: Record<string, string>
      ) => ({
        ok: true,
        observedHome: expected.home,
        observedUserDataPath: expected.userDataPath,
        observedHomeRealpath: expected.homeRealpath,
        observedUserDataRealpath: expected.userDataRealpath,
        expression: 'isolation probe (fake)'
      }),
      liveSmokeRound: async (round: {
        prompt: string
        chatId: string
        previousRoundId: string
      }) => {
        roundCalls.push({ prompt: round.prompt, chatId: round.chatId })
        return {
          outcome: 'settled',
          status: 'started',
          roundId: round.previousRoundId === null ? 'round-warmup' : 'round-smoke',
          roundStatus: 'completed',
          turnsFinished: 4,
          d1: { delta: { deferredAppends: 3, normalSaves: 2 } }
        }
      },
      hostWelcomeProbe: async () => ({
        ok: true,
        expectedIdentity: { instanceId: 'host-1', generation: 1, pid: 4243 }
      }),
      hostWindowSnapshotRead: async () => null,
      hostWindowSamplerTimers: { setInterval: () => 1, clearInterval: () => {} },
      ...(withPhase
        ? {
            runManyAgents: async (input: PhaseCall) => {
              phaseCalls.push(input)
              return { verdict: { ok: true, reasons: [] } }
            }
          }
        : {}),
      terminateOptions: { waitMs: 20, sleep: async () => {}, killProcessGroup: () => {} }
    }
  ).then(
    (result) => ({ result: result as Record<string, any>, error: null }),
    (error: unknown) => ({ result: null, error: error as Error })
  )
  return { ...outcome, phaseCalls, roundCalls, daemonStarts }
}

const CHATS = ['perf-many_agents_live-chat-01', 'perf-many_agents_live-chat-02']

describe('a relaunch on the profile an earlier launch left', () => {
  it('launches it as it is: nothing written, no warm-up or smoke, the caller’s phase alone', async () => {
    const home = makeHome()
    const first = await launch(home, ['--materialize-instance-userdata'])
    expect(first.error).toBeNull()
    // The first launch tells the phase what it sent before it, each with its chat.
    expect(first.roundCalls.map((round) => round.chatId)).toEqual([CHATS[0], CHATS[0]])
    expect(first.phaseCalls[0].priorRounds).toMatchObject([
      { purpose: 'warm_up', roundId: 'round-warmup', status: 'started', chatId: CHATS[0] },
      { purpose: 'smoke', roundId: 'round-smoke', status: 'started', chatId: CHATS[0] }
    ])
    expect(first.result!.report.launchPlan.profileReused).toBe(false)

    // What the first launch left, and something only this test wrote there.
    writeFileSync(path.join(profileOf(home), 'left-by-the-first-launch.txt'), 'kept')
    const left = digestTree(profileOf(home))

    const second = await launch(home, ['--reuse-instance-userdata'])
    expect(second.error).toBeNull()
    expect(digestTree(profileOf(home))).toEqual(left)
    expect(second.roundCalls).toEqual([])
    expect(second.phaseCalls).toHaveLength(1)
    expect(second.phaseCalls[0].priorRounds).toEqual([])
    expect(second.phaseCalls[0].threads).toHaveLength(2)
    const report = second.result!.report
    expect(report.launchPlan.profileReused).toBe(true)
    expect(report.liveRounds.warmUpAndSmoke).toBe('skipped_profile_reused')
    expect(report.liveRounds.verdict).toEqual({ ok: true, reasons: [] })
    expect(second.result!.ok).toBe(true)
  })

  it('is refused with nothing to relaunch, before its daemon starts', async () => {
    const home = makeHome()
    const { error, daemonStarts, phaseCalls } = await launch(home, ['--reuse-instance-userdata'])
    expect(error?.message).toBe(
      `Refusing --reuse-instance-userdata: there is no profile at ${profileOf(home)} to launch again`
    )
    expect(daemonStarts).toEqual([])
    expect(phaseCalls).toEqual([])
  })

  it('is refused beside anything that would write the profile, or without a launch', async () => {
    const home = makeHome()
    const refusal = async (args: string[], withPhase = true) =>
      (await launch(home, args, withPhase)).error?.message
    expect(await refusal(['--reuse-instance-userdata', '--materialize-instance-userdata'])).toBe(
      '--reuse-instance-userdata launches the profile as it is; refuse --materialize-instance-userdata and --out-dir with it'
    )
    expect(
      await refusal(['--reuse-instance-userdata', `--out-dir=${makeDirectory(tmpdir())}`])
    ).toBe(
      '--reuse-instance-userdata launches the profile as it is; refuse --materialize-instance-userdata and --out-dir with it'
    )
    expect(await refusal(['--reuse-instance-userdata', '--dry-run'])).toBe(
      '--reuse-instance-userdata relaunches a profile: pass it with --launch, never --dry-run'
    )
    expect(await refusal(['--reuse-instance-userdata'], false)).toBe(
      "--reuse-instance-userdata keeps the first launch's state, its model daemon among it, so only a caller's own --live-agents phase may run on it"
    )
    await expect(
      runT2BaselineCli(
        ['--workload=many_agents_live', '--live-agents', '--reuse-instance-userdata'],
        { repoRoot, provenance: PROVENANCE, runManyAgents: async () => ({}) }
      )
    ).rejects.toThrow(
      '--reuse-instance-userdata relaunches a profile: pass it with --launch, never --dry-run'
    )
  })
})
