import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createT2HostWindowSampler, runT2BaselineCli } = require('./runT2Baseline.cjs') as {
  createT2HostWindowSampler: (options: Record<string, unknown>) => {
    start: () => Promise<boolean>
    sampleOnce: () => Promise<boolean>
    stop: () => {
      accepted: number
      duplicateSequence: number
      nonMonotonicSequence: number
      refusals: Record<string, number>
      samples: Array<Record<string, unknown>>
    }
  }
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
const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function dryRun(extra: string[]) {
  const artifactDir = mkdtempSync(path.join(tmpdir(), 'perf-t2-lanes-'))
  temporaryPaths.push(artifactDir)
  return runT2BaselineCli(['--dry-run', `--artifact-dir=${artifactDir}`, ...extra], {
    repoRoot,
    provenance: PROVENANCE
  })
}

describe('runT2Baseline --live-lanes', () => {
  it('implies --live-rounds on the live workload', async () => {
    await expect(
      dryRun(['--workload=light_beside_large_live', '--live-lanes'])
    ).resolves.toMatchObject({ ok: true, dryRun: true, launched: false })
  })

  it('is refused on a replay workload and beside the replay modes', async () => {
    await expect(dryRun(['--workload=light_beside_large', '--live-lanes'])).rejects.toMatchObject({
      code: 'T2_LIVE_ROUNDS_WORKLOAD',
      message: expect.stringMatching(/replay workload/)
    })
    await expect(
      dryRun(['--workload=light_beside_large_live', '--live-lanes', '--windowed-replay'])
    ).rejects.toMatchObject({ code: 'T2_LIVE_ROUNDS_MODE' })
  })
})

describe('the Host window sampler feeding the S3b union (S5d)', () => {
  const PIN = { instanceId: 'host-1', generation: 1, pid: 4242 }
  const probe = async () => ({ ok: true, expectedIdentity: { ...PIN } })
  const timers = { setInterval: () => 1, clearInterval: () => {} }

  function read(sequence: number) {
    return {
      identity: { process: 'host', ...PIN },
      sequence,
      capturedAt: new Date(sequence * 5_000).toISOString(),
      eventLoopLag: { unsupported: 'host_perf_lag_unobserved' },
      workSpans: {
        process: 'host',
        recorded: sequence,
        byKind: {},
        recentSpans: { encoding: 'ring_tail_rows_v1', rows: [[sequence]] }
      }
    }
  }

  function sampler(sequences: number[], union?: { add: (sample: unknown) => unknown }) {
    const inputs: Array<Record<string, unknown>> = []
    const reads = sequences.map(read)
    const instance = createT2HostWindowSampler({
      userDataPath: '/virtual/userData',
      hostPerfSnapshotPath: '/virtual/host-perf-snapshot.json',
      requiredChatIds: ['chat-light', 'chat-heavy'],
      probe,
      read: async (input: Record<string, unknown>) => {
        inputs.push(input)
        return reads.shift()
      },
      timers,
      ...(union === undefined ? {} : { recentSpanUnion: union })
    })
    return { instance, inputs }
  }

  it('asks for the tail, hands each accepted read to the union in order, and keeps none', async () => {
    const added: Array<{ sequence: number; workSpans: Record<string, unknown> }> = []
    const { instance, inputs } = sampler([1, 1, 3, 2, 4], {
      add: (sample) => {
        added.push(sample as (typeof added)[number])
        return { ok: true }
      }
    })
    await instance.start()
    for (let poll = 0; poll < 5; poll += 1) await instance.sampleOnce()
    const summary = instance.stop()

    expect(inputs.every((input) => input.keepRecentSpans === true)).toBe(true)
    expect(inputs).toHaveLength(5)
    // Only strictly increasing reads reach the union, each with its tail.
    expect(added.map((sample) => sample.sequence)).toEqual([1, 3, 4])
    expect(added.map((sample) => sample.workSpans.recentSpans)).toEqual([
      { encoding: 'ring_tail_rows_v1', rows: [[1]] },
      { encoding: 'ring_tail_rows_v1', rows: [[3]] },
      { encoding: 'ring_tail_rows_v1', rows: [[4]] }
    ])
    expect(summary).toMatchObject({ accepted: 3, duplicateSequence: 1, nonMonotonicSequence: 1 })
    // The retained reads keep everything but the tail.
    expect(summary.samples.map((sample) => sample.workSpans)).toEqual([
      { process: 'host', recorded: 1, byKind: {} },
      { process: 'host', recorded: 3, byKind: {} },
      { process: 'host', recorded: 4, byKind: {} }
    ])
    expect(summary.samples[0]).toMatchObject({ sequence: 1, capturedAt: read(1).capturedAt })
  })

  it('names a union refusal and still keeps the read', async () => {
    const { instance } = sampler([1, 2], {
      add: (sample) =>
        (sample as { sequence: number }).sequence === 2
          ? { ok: false, reason: 'sample.identity changed: another Host' }
          : { ok: true }
    })
    await instance.start()
    await instance.sampleOnce()
    await instance.sampleOnce()
    const summary = instance.stop()
    expect(summary.accepted).toBe(2)
    expect(summary.samples).toHaveLength(2)
    expect(summary.refusals).toEqual({
      'host_window_union_refused: sample.identity changed: another Host': 1
    })
  })

  it('builds windowed replay’s sampler from the options the live lanes use (wiring pin)', () => {
    // A structural read of the runner: every sampler it builds starts from the
    // one options factory, and only the live lanes' adds the union. It throws
    // when a call site moves rather than passing over nothing.
    const file = new URL('./runT2Baseline.cjs', import.meta.url)
    const source = ts.createSourceFile(
      'runT2Baseline.cjs',
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    const calls: Array<{ spread: string[]; own: string[] }> = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createT2HostWindowSampler'
      ) {
        const [argument] = node.arguments
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          throw new Error('a createT2HostWindowSampler call no longer takes an object literal')
        }
        calls.push({
          spread: argument.properties
            .filter(ts.isSpreadAssignment)
            .map((property) => property.expression.getText(source)),
          own: argument.properties
            .filter((property) => !ts.isSpreadAssignment(property))
            .map((property) => property.name?.getText(source) ?? '?')
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toEqual([
      { spread: ['hostWindowSamplerOptions()'], own: ['recentSpanUnion'] },
      { spread: ['hostWindowSamplerOptions()'], own: [] }
    ])
  })

  it('leaves windowed replay’s reads exactly as they were without a union', async () => {
    const { instance, inputs } = sampler([1])
    await instance.start()
    await instance.sampleOnce()
    const summary = instance.stop()
    expect(inputs[0]).not.toHaveProperty('keepRecentSpans')
    expect(summary.samples).toEqual([read(1)])
  })
})

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

const socketSends: Array<{ url: string; method: string; expression?: string }> = []

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
    socketSends.push({
      url: this.url,
      method: message.method,
      expression: message.params?.expression
    })
    queueMicrotask(() => this.handlers.message(JSON.stringify({ id: message.id, result: {} })))
  }
  close() {
    // Nothing to release.
  }
}

type LanesCall = {
  page: { evaluate: (expression: string) => Promise<unknown> }
  mainSession: { post: (method: string, params: unknown) => Promise<unknown> }
  lightChatId: string
  lightChatTitle: string
  heavyChatId: string
  laneModels: { light: string; heavy: string }
  readDaemonActivity: (query: { model: string; fromMs: number; toMs: number }) => Promise<unknown>
  nowMs: unknown
  createHostSampler: (union: { add: (sample: unknown) => unknown }) => {
    start: () => Promise<boolean>
    sampleOnce: () => Promise<boolean>
    stop: () => { samples: Array<Record<string, unknown>> }
  }
  onWindow: (window: { repetition: number; reasons: string[] }) => void
}

describe('runT2Baseline --live-lanes launch wiring', () => {
  const daemonRequests: string[] = []
  let daemon: Server | null = null

  afterEach(async () => {
    daemonRequests.length = 0
    if (daemon !== null) {
      const closing = daemon
      daemon = null
      await new Promise((resolve) => closing.close(resolve))
    }
  })

  /** The scripted daemon's activity route on loopback, answering one fixed record. */
  async function activityDaemon(): Promise<string> {
    daemon = createServer((request, response) => {
      daemonRequests.push(String(request.url))
      const url = new URL(String(request.url), 'http://127.0.0.1')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          model: url.searchParams.get('model'),
          fromMs: Number(url.searchParams.get('from')),
          toMs: Number(url.searchParams.get('to')),
          started: 5,
          done: 4,
          busyMs: 600,
          maxQuietMs: 300
        })
      )
    })
    const listening = daemon
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  }

  /**
   * A launch whose child, sockets and isolation proof are fakes, so the run
   * reaches the live-round block exactly as a real one does. The smoke's
   * rounds and the lanes phase are the seams under test; the daemon's
   * activity route is a real loopback server.
   */
  async function launchLanes(smokeOk: boolean) {
    const daemonBaseUrl = await activityDaemon()
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-lanes-'))
    temporaryPaths.push(home)
    const artifacts = mkdtempSync(path.join(tmpdir(), 'perf-t2-lanes-'))
    temporaryPaths.push(artifacts)
    const lanesCalls: LanesCall[] = []
    const snapshotReads: Array<Record<string, unknown>> = []
    socketSends.length = 0
    const outcome = await runT2BaselineCli(
      [
        '--workload=light_beside_large_live',
        '--live-lanes',
        '--launch',
        '--accept-unfolded-cross-thread',
        '--i-accept-isolated-launch',
        '--materialize-instance-userdata',
        '--lean',
        '--instance-id=perfLanes01',
        `--home=${home}`,
        `--artifact-dir=${artifacts}`,
        '--port=9415',
        '--inspect-port=9815'
      ],
      {
        repoRoot,
        forceIsolated: true,
        allowDirtyLaunch: true,
        allowNonIsolatedLaunch: true,
        platform: 'darwin',
        provenance: PROVENANCE,
        minFreeDiskBytes: 0,
        // The capture phases after the lanes are not under test: a spent
        // budget skips each of them, as a real overrun would.
        maxCapturePhaseMs: 0,
        env: { ...process.env },
        startScriptedDaemon: async () => ({
          pid: 7778,
          baseUrl: daemonBaseUrl,
          stop: async () => ({
            exit: { code: 0, signal: null },
            forced: false,
            summary: { schemaVersion: 1 },
            stderrTail: ''
          })
        }),
        buildAdapters: { build: async () => ({ code: 0 }) },
        hostBundleAdapters: { fs: freshHostBundleFs() },
        externalHostAdapters: { exists: () => true },
        spawnAdapters: {
          resolveElectronPath: () => '/virtual/Electron',
          spawn: () => {
            const child = new EventEmitter()
            return Object.assign(child, {
              pid: 9292,
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
          probeCdp: async () => ({ port: 9415, reachable: false }),
          listInstancePids: () => []
        },
        portOwnershipAdapters: {
          listPortPids: async () => [9292],
          timeoutMs: 1000,
          initialDelayMs: 0,
          sleep: async () => {}
        },
        mainInspectorUrl: 'ws://127.0.0.1:9815/main',
        WebSocket: QuietCdpSocket,
        cdpAdapters: {
          httpGetJson: async (url: string) =>
            String(url).includes('/json/version')
              ? { Browser: 'Fake/1' }
              : [
                  {
                    type: 'page',
                    id: 'p1',
                    webSocketDebuggerUrl: 'ws://127.0.0.1:9415/devtools/page/p1'
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
        liveSmokeRound: async (round: { prompt: string; previousRoundId: string | null }) => ({
          outcome: 'settled',
          status: 'started',
          roundId: round.previousRoundId === null ? 'round-warmup' : 'round-smoke',
          roundStatus: 'completed',
          turnsFinished: 4,
          d1: {
            delta: smokeOk
              ? { deferredAppends: 3, normalSaves: 2 }
              : { deferredAppends: 0, normalSaves: 0 }
          }
        }),
        hostWelcomeProbe: async () => ({
          ok: true,
          expectedIdentity: { instanceId: 'host-1', generation: 1, pid: 4242 }
        }),
        hostWindowSnapshotRead: async (input: Record<string, unknown>) => {
          snapshotReads.push(input)
          return {
            identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
            sequence: snapshotReads.length,
            capturedAt: new Date(snapshotReads.length * 5_000).toISOString(),
            workSpans: { process: 'host', recentSpans: { rows: [] } }
          }
        },
        hostWindowSamplerTimers: { setInterval: () => 1, clearInterval: () => {} },
        runLiveLanes: async (input: LanesCall) => {
          lanesCalls.push(input)
          await input.mainSession.post('Runtime.evaluate', { expression: 'main probe' })
          await input.page.evaluate('page probe')
          input.onWindow({ repetition: 0, reasons: [] })
          const added: unknown[] = []
          const sampler = input.createHostSampler({
            add: (sample) => {
              added.push(sample)
              return { ok: true }
            }
          })
          await sampler.start()
          await sampler.sampleOnce()
          const summary = sampler.stop()
          const activity = await input.readDaemonActivity({
            model: input.laneModels.heavy,
            fromMs: 1_000,
            toMs: 121_000
          })
          return {
            windows: [],
            added,
            kept: summary.samples,
            activity,
            teardown: { light: 'not_running', heavy: 'failed', observer: 'uninstalled' },
            verdict: { ok: false, reasons: ['window 0: d1_no_deferred_append'] }
          }
        },
        terminateOptions: {
          waitMs: 20,
          sleep: async () => {},
          killProcessGroup: () => {}
        }
      }
    ).then(
      (result) => ({ result: result as Record<string, unknown>, error: null }),
      (error: unknown) => ({ result: null, error: error as Error })
    )
    return { ...outcome, lanesCalls, snapshotReads, artifacts }
  }

  it('runs the lanes once the smoke settled, on the fixture’s two chats', async () => {
    const { result, error, lanesCalls, snapshotReads, artifacts } = await launchLanes(true)
    expect(error).toBeNull()
    expect(lanesCalls).toHaveLength(1)
    const [call] = lanesCalls
    expect(call.lightChatId).toBe('perf-light_beside_large_live-chat-01')
    expect(call.lightChatTitle).toBe('Perf fixture light_beside_large_live #1')
    expect(call.heavyChatId).toBe('perf-light_beside_large_live-chat-02')
    // Each lane's turns are told apart by its chat's own scripted tag.
    expect(call.laneModels).toEqual({
      light: 'scripted-llama:latest',
      heavy: 'scripted-llama:heavy'
    })
    expect(typeof call.nowMs).toBe('function')
    // Main's reads go to main's inspector, page calls to the renderer.
    const probes = socketSends.filter((send) => send.expression?.endsWith(' probe'))
    expect(probes).toEqual([
      { url: 'ws://127.0.0.1:9815/main', method: 'Runtime.evaluate', expression: 'main probe' },
      {
        url: 'ws://127.0.0.1:9415/devtools/page/p1',
        method: 'Runtime.evaluate',
        expression: 'page probe'
      }
    ])
    // Each window reaches the progress journal as it closes.
    const progress = JSON.parse(readFileSync(path.join(artifacts, 'perf-t2-progress.json'), 'utf8'))
    // Named for what they are: the Host fold may still censor the window.
    expect(progress.liveLaneWindow).toEqual({ repetition: 0, reasonsBeforeHostFold: [] })

    // The sampler it builds reads the armed snapshot with the tail, feeds the
    // union, and keeps the read without it.
    expect(snapshotReads).toHaveLength(1)
    expect(snapshotReads[0]).toMatchObject({
      hostPerfSnapshotPath: path.join(artifacts, 'host-perf-snapshot.json'),
      keepRecentSpans: true,
      requiredChatIds: [call.lightChatId, call.heavyChatId]
    })
    const report = (result as { report: Record<string, any> }).report
    const lanes = report.liveRounds.lanes
    expect(lanes.added).toHaveLength(1)
    expect(lanes.added[0].workSpans).toHaveProperty('recentSpans')
    expect(lanes.kept[0].workSpans).not.toHaveProperty('recentSpans')

    // The lanes' activity reader asks the run's own daemon, by tag and range.
    expect(daemonRequests).toEqual([
      '/_scripted/activity?model=scripted-llama%3Aheavy&from=1000&to=121000'
    ])
    expect(lanes.activity).toEqual({ started: 5, done: 4, busyMs: 600, maxQuietMs: 300 })

    // The lanes' verdict joins the smoke's and decides the run.
    expect(report.liveRounds.verdict).toEqual({
      ok: false,
      reasons: ['lanes: window 0: d1_no_deferred_append']
    })
    // A teardown step that failed is a cleanup failure, not a verdict reason.
    expect(report.cleanupFailures).toContainEqual({
      phase: 'liveLanes.teardown',
      error: "the heavy lane's round could not be cancelled"
    })
    expect((result as { ok: boolean }).ok).toBe(false)
  })

  it('never starts the lanes after a failed smoke, and says so', async () => {
    const { result, error, lanesCalls } = await launchLanes(false)
    expect(error).toBeNull()
    expect(lanesCalls).toEqual([])
    const report = (result as { report: Record<string, any> }).report
    expect(report.liveRounds.lanes).toBeNull()
    expect(report.liveRounds.verdict.reasons).toEqual([
      'smoke: no deferred journal append',
      'smoke: no normal-boundary save',
      'lanes: not run'
    ])
  })
})
