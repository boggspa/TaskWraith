import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function dryRun(extra: string[]) {
  const artifactDir = mkdtempSync(path.join(tmpdir(), 'perf-t2-agents-'))
  temporaryPaths.push(artifactDir)
  return runT2BaselineCli(['--dry-run', `--artifact-dir=${artifactDir}`, ...extra], {
    repoRoot,
    provenance: PROVENANCE
  })
}

describe('runT2Baseline --live-agents', () => {
  it('implies --live-rounds on the many-agent workload', async () => {
    await expect(dryRun(['--workload=many_agents_live', '--live-agents'])).resolves.toMatchObject({
      ok: true,
      dryRun: true,
      launched: false
    })
  })

  it('is refused on any other live workload, and beside the live lanes', async () => {
    await expect(
      dryRun(['--workload=light_beside_large_live', '--live-agents'])
    ).rejects.toMatchObject({ code: 'T2_LIVE_AGENTS_FIXTURE' })
    await expect(
      dryRun(['--workload=many_agents_live', '--live-agents', '--live-lanes'])
    ).rejects.toThrow('--live-agents and --live-lanes drive different workloads; pass one')
  })

  it('refuses the shape options without it', async () => {
    for (const option of [
      '--agent-threads=3',
      '--agent-seats=2',
      '--agent-mode=parallel',
      '--agent-window-ms=30000'
    ]) {
      await expect(
        dryRun(['--workload=many_agents_live', '--live-rounds', option])
      ).rejects.toThrow('agent options require --live-agents')
    }
  })

  it('refuses a shape the workload cannot be', async () => {
    const refusal = (option: string) =>
      dryRun(['--workload=many_agents_live', '--live-agents', option]).then(
        () => null,
        (error: unknown) => (error as Error).message
      )
    expect(await refusal('--agent-threads=0')).toBe('threads must be a whole number from 1 to 200')
    expect(await refusal('--agent-threads=abc')).toBe(
      'threads must be a whole number from 1 to 200'
    )
    expect(await refusal('--agent-seats=51')).toBe('seats must be a whole number from 1 to 50')
    expect(await refusal('--agent-mode=both')).toBe('seatMode must be serial or parallel')
    for (const value of ['abc', '1.5', '4999', '600001', '']) {
      expect(await refusal(`--agent-window-ms=${value}`)).toBe(
        'agent window must be a whole number of milliseconds from 5000 to 600000'
      )
    }
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

type AgentsCall = {
  page: { evaluate: (expression: string) => Promise<unknown> }
  mainSession: { post: (method: string, params: unknown) => Promise<unknown> }
  threads: Array<{ chatId: string; model: string }>
  seats: number
  seatMode: string
  configuredTurnMs: number
  windowMs?: number
  laneOptions?: Record<string, unknown>
  readDaemonTurns: (range: { fromMs: number; toMs: number }) => Promise<unknown>
  nowMs: unknown
  createHostSampler: (union: { add: (sample: unknown) => unknown }) => {
    start: () => Promise<boolean>
    sampleOnce: () => Promise<boolean>
    stop: () => { samples: Array<Record<string, unknown>> }
  }
  onWindow: (window: { repetition: number; reasons: string[] }) => void
  onCalibrationMarker: (marker: Record<string, unknown>) => void
  onCalibrationFailure: (reason: string) => void
}

describe('runT2Baseline --live-agents launch wiring', () => {
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

  /** The scripted daemon's turns route on loopback, answering one turn. */
  async function turnsDaemon(): Promise<string> {
    daemon = createServer((request, response) => {
      daemonRequests.push(String(request.url))
      const url = new URL(String(request.url), 'http://127.0.0.1')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          fromMs: Number(url.searchParams.get('from')),
          toMs: Number(url.searchParams.get('to')),
          turns: [
            { model: 'scripted-llama:t001', startedAtMs: 1_500, endedAtMs: 3_100, outcome: 'done' }
          ]
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
   * rounds and the many-agent phase are the seams under test; the daemon's
   * turns route is a real loopback server.
   */
  async function launchAgents(
    smokeOk: boolean,
    extraArgs: string[] = [],
    measured?: (input: AgentsCall, artifacts: string) => Record<string, unknown>,
    mode: string[] = ['--live-agents']
  ) {
    const daemonBaseUrl = await turnsDaemon()
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-agents-'))
    temporaryPaths.push(home)
    const artifacts = mkdtempSync(path.join(tmpdir(), 'perf-t2-agents-'))
    temporaryPaths.push(artifacts)
    const agentsCalls: AgentsCall[] = []
    const snapshotReads: Array<Record<string, unknown>> = []
    const roundCalls: Array<{ prompt: string; chatId: string; timeoutMs: number | undefined }> = []
    const progressLines: string[] = []
    socketSends.length = 0
    const outcome = await runT2BaselineCli(
      [
        '--workload=many_agents_live',
        ...mode,
        '--launch',
        '--accept-unfolded-cross-thread',
        '--i-accept-isolated-launch',
        '--materialize-instance-userdata',
        '--lean',
        '--instance-id=perfAgents01',
        `--home=${home}`,
        `--artifact-dir=${artifacts}`,
        '--port=9416',
        '--inspect-port=9816',
        ...extraArgs
      ],
      {
        repoRoot,
        forceIsolated: true,
        allowDirtyLaunch: true,
        allowNonIsolatedLaunch: true,
        platform: 'darwin',
        provenance: PROVENANCE,
        minFreeDiskBytes: 0,
        progressLog: (line: string) => progressLines.push(line),
        // The capture phases after the agents are not under test: a spent
        // budget skips each of them, as a real overrun would.
        maxCapturePhaseMs: 0,
        env: { ...process.env },
        startScriptedDaemon: async () => ({
          pid: 7779,
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
              pid: 9293,
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
          probeCdp: async () => ({ port: 9416, reachable: false }),
          listInstancePids: () => []
        },
        portOwnershipAdapters: {
          listPortPids: async () => [9293],
          timeoutMs: 1000,
          initialDelayMs: 0,
          sleep: async () => {}
        },
        mainInspectorUrl: 'ws://127.0.0.1:9816/main',
        WebSocket: QuietCdpSocket,
        cdpAdapters: {
          httpGetJson: async (url: string) =>
            String(url).includes('/json/version')
              ? { Browser: 'Fake/1' }
              : [
                  {
                    type: 'page',
                    id: 'p1',
                    webSocketDebuggerUrl: 'ws://127.0.0.1:9416/devtools/page/p1'
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
          previousRoundId: string | null
          timeoutMs?: number
        }) => {
          roundCalls.push({
            prompt: round.prompt,
            chatId: round.chatId,
            timeoutMs: round.timeoutMs
          })
          return {
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
          }
        },
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
        runManyAgents: async (input: AgentsCall) => {
          agentsCalls.push(input)
          await input.mainSession.post('Runtime.evaluate', { expression: 'main probe' })
          await input.page.evaluate('page probe')
          input.onWindow({ repetition: 0, reasons: ['round_failed'] })
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
          const turns = await input.readDaemonTurns({ fromMs: 1_000, toMs: 121_000 })
          return {
            windows: [],
            added,
            kept: summary.samples,
            turns,
            teardown: {
              rounds: { notRunning: 2, cancelled: 0, notCancelled: 0, failed: 1 },
              observer: 'uninstalled'
            },
            verdict: { ok: false, reasons: ['window 0: round_failed'] },
            ...(measured ? measured(input, artifacts) : {})
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
    return { ...outcome, agentsCalls, snapshotReads, roundCalls, progressLines, artifacts }
  }

  const SMALL = ['--agent-threads=3', '--agent-seats=2', '--agent-mode=parallel']
  const SMALL_CHATS = [
    'perf-many_agents_live-chat-01',
    'perf-many_agents_live-chat-02',
    'perf-many_agents_live-chat-03'
  ]

  it('runs the phase once the smoke settled, on the shape the operator asked for', async () => {
    const { result, error, agentsCalls, snapshotReads, roundCalls, progressLines, artifacts } =
      await launchAgents(true, [...SMALL, '--agent-window-ms=30000'])
    expect(error).toBeNull()
    expect(agentsCalls).toHaveLength(1)
    // The phase is named in the run's progress, after the smoke's.
    const phases = progressLines.map((line) => line.split(' ')[1])
    expect(phases).toContain('running/live_agents')
    expect(phases.indexOf('running/live_agents')).toBeGreaterThan(
      phases.indexOf('running/live_rounds')
    )
    const [call] = agentsCalls
    // Each thread's turns are told apart by its chat's own scripted tag.
    expect(call.threads).toEqual([
      { chatId: SMALL_CHATS[0], model: 'scripted-llama:t001' },
      { chatId: SMALL_CHATS[1], model: 'scripted-llama:t002' },
      { chatId: SMALL_CHATS[2], model: 'scripted-llama:t003' }
    ])
    expect(call).toMatchObject({ seats: 2, seatMode: 'parallel', windowMs: 30_000 })
    // The scripted model's own pace: 64 chunks 25 ms apart.
    expect(call.configuredTurnMs).toBe(1_600)
    expect(typeof call.nowMs).toBe('function')
    expect(call).not.toHaveProperty('laneOptions')
    // Main's reads go to main's inspector, page calls to the renderer.
    const probes = socketSends.filter((send) => send.expression?.endsWith(' probe'))
    expect(probes).toEqual([
      { url: 'ws://127.0.0.1:9816/main', method: 'Runtime.evaluate', expression: 'main probe' },
      {
        url: 'ws://127.0.0.1:9416/devtools/page/p1',
        method: 'Runtime.evaluate',
        expression: 'page probe'
      }
    ])
    // The window reaches the progress journal as it closes.
    const progress = JSON.parse(readFileSync(path.join(artifacts, 'perf-t2-progress.json'), 'utf8'))
    expect(progress.liveAgentsWindow).toEqual({ repetition: 0, reasons: ['round_failed'] })

    // Only the first thread is warmed up and smoked: no round on every thread in turn.
    expect(roundCalls.map((round) => [round.prompt, round.chatId])).toEqual([
      ['M1 live warm_up round: answer briefly.', SMALL_CHATS[0]],
      ['M1 live smoke round: answer briefly.', SMALL_CHATS[0]]
    ])

    // The sampler it builds reads the armed snapshot with the tail, feeds the
    // union, and keeps the read without it.
    expect(snapshotReads).toHaveLength(1)
    expect(snapshotReads[0]).toMatchObject({
      hostPerfSnapshotPath: path.join(artifacts, 'host-perf-snapshot.json'),
      keepRecentSpans: true,
      requiredChatIds: SMALL_CHATS
    })
    const report = (result as { report: Record<string, any> }).report
    const agents = report.liveRounds.agents
    expect(agents.added).toHaveLength(1)
    expect(agents.added[0].workSpans).toHaveProperty('recentSpans')
    expect(agents.kept[0].workSpans).not.toHaveProperty('recentSpans')

    // The phase's turns reader asks the run's own daemon, by range.
    expect(daemonRequests).toEqual(['/_scripted/turns?from=1000&to=121000'])
    expect(agents.turns).toEqual([
      { model: 'scripted-llama:t001', startedAtMs: 1_500, endedAtMs: 3_100, outcome: 'done' }
    ])

    // The phase's verdict joins the smoke's and decides the run.
    expect(report.liveRounds.verdict).toEqual({
      ok: false,
      reasons: ['agents: window 0: round_failed']
    })
    expect(report.liveRounds).not.toHaveProperty('lanes')
    // A teardown step that failed is a cleanup failure, not a verdict reason.
    expect(report.cleanupFailures).toContainEqual({
      phase: 'liveAgents.teardown',
      error: '1 thread round(s) could not be cancelled'
    })
    expect((result as { ok: boolean }).ok).toBe(false)
    expect(report.fixture.shape.manyAgents).toEqual({
      threads: 3,
      seats: 2,
      seatMode: 'parallel',
      agents: 6
    })
  })

  it('asks for 200 agents, seats one after another, when the operator gives no shape', async () => {
    const { error, agentsCalls } = await launchAgents(true)
    expect(error).toBeNull()
    const [call] = agentsCalls
    expect(call.threads).toHaveLength(20)
    expect(call.threads[19]).toEqual({
      chatId: 'perf-many_agents_live-chat-20',
      model: 'scripted-llama:t020'
    })
    expect(call).toMatchObject({ seats: 10, seatMode: 'serial' })
    // The window is the phase's own default unless the operator names one.
    expect(call).not.toHaveProperty('windowMs')
  })

  it('never starts the phase after a failed smoke, and says so', async () => {
    const { result, error, agentsCalls, progressLines } = await launchAgents(false, SMALL)
    expect(error).toBeNull()
    expect(agentsCalls).toEqual([])
    expect(progressLines.some((line) => line.includes('/live_agents'))).toBe(false)
    const report = (result as { report: Record<string, any> }).report
    expect(report.liveRounds.agents).toBeNull()
    expect(report.liveRounds.verdict.reasons).toEqual([
      'smoke: no deferred journal append',
      'smoke: no normal-boundary save',
      'agents: not run'
    ])
    expect(report).not.toHaveProperty('mainThreadShares')
  })

  it('gives every thread’s rounds the timeout the operator asked for', async () => {
    const { error, agentsCalls, roundCalls } = await launchAgents(true, [
      ...SMALL,
      '--live-round-timeout-ms=600000'
    ])
    expect(error).toBeNull()
    expect(agentsCalls[0].laneOptions).toEqual({ roundTimeoutMs: 600_000 })
    expect(roundCalls.map((round) => round.timeoutMs)).toEqual([600_000, 600_000])
  })

  it('smokes the first thread only when the phase is not asked for', async () => {
    const { result, error, agentsCalls, roundCalls } = await launchAgents(true, [], undefined, [
      '--live-rounds'
    ])
    expect(error).toBeNull()
    expect(agentsCalls).toEqual([])
    expect(roundCalls).toHaveLength(2)
    const report = (result as { report: Record<string, any> }).report
    expect(report.liveRounds).not.toHaveProperty('agents')
    expect(report.liveRounds.verdict).toEqual({ ok: true, reasons: [] })
  })

  // A 150 ms main profile whose window is performance.now 30..130 ms: 30 ms
  // idle, 20 ms in a run-event sync, 50 ms streaming.
  function measuredWindow(input: AgentsCall, artifacts: string) {
    const frame = (functionName: string, url: string) => ({
      functionName,
      url,
      lineNumber: 50,
      columnNumber: 0
    })
    const bundle = 'file:///virtual-build/out/main/index-AbCd1234.js'
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', ''), children: [2, 3, 4, 5, 8] },
        { id: 2, callFrame: frame('start', 'taskwraith-calibration-start.js') },
        { id: 3, callFrame: frame('end', 'taskwraith-calibration-end.js') },
        { id: 4, callFrame: frame('(idle)', '') },
        { id: 5, callFrame: frame('appendRunEvent', bundle), children: [6] },
        { id: 6, callFrame: frame('fsyncSync', 'node:fs'), children: [7] },
        { id: 7, callFrame: frame('fsync', '') },
        { id: 8, callFrame: frame('streamTurn', bundle) }
      ],
      samples: [2, 2, 4, 4, 7, 8, 3, 3],
      timeDeltas: [11_000, 6_000, 13_000, 30_000, 20_000, 50_000, 11_000, 6_000],
      startTime: 1_000_000,
      endTime: 1_150_000
    }
    writeFileSync(path.join(artifacts, 'profiles', 'main.cpuprofile'), JSON.stringify(profile))
    const identity = 'main:42:performance.timeOrigin:5000'
    for (const [tag, beforeMs, afterMs] of [
      ['start', 10, 18],
      ['end', 140, 148]
    ] as const) {
      const source = `source of ${tag}`
      input.onCalibrationMarker({
        tag,
        beforeMs,
        afterMs,
        pid: 42,
        timeOrigin: 5000,
        identity,
        clockId: 'node.performance.now',
        windowId: 'many_agents_0',
        source,
        sourceSha256: createHash('sha256').update(source).digest('hex')
      })
    }
    input.onCalibrationFailure('window_end_marker_failed')
    return {
      windows: [
        {
          role: 'many-agents',
          repetition: 0,
          startedAtMs: 1_000_000,
          endedAtMs: 1_120_000,
          reasons: [],
          mainWindow: {
            id: 'many_agents_0',
            startedAtMs: 30,
            endedAtMs: 130,
            clock: {
              clockId: 'node.performance.now',
              identity,
              provenance: 'node-performance-now'
            },
            eventLoopLag: { p50Ms: 2, p95Ms: 12, p99Ms: 20, maxMs: 40, meanMs: 3 }
          },
          mainWindowCensored: false
        }
      ]
    }
  }

  it('reports where the main thread’s time went in the window it measured', async () => {
    const { result, error, artifacts } = await launchAgents(true, SMALL, measuredWindow)
    expect(error).toBeNull()
    const report = (result as { report: Record<string, any> }).report
    expect(report.mainThreadShares).toMatchObject({
      frameMatching: 'bundled_base_names_and_class_lines',
      windows: [
        {
          id: 'many_agents_0',
          repetition: 0,
          measured: true,
          clock: { basis: 'markers' },
          shares: { idle: 0.3, busy: 0.7, sync: 0.2 },
          syncOwners: { runEvents: 0.2 }
        }
      ]
    })
    // The phase exits are the two-lane workload's: none is judged here.
    expect(report).not.toHaveProperty('phaseExits')
    // The markers are kept beside the profile, so the capture can be measured again.
    const kept = JSON.parse(
      readFileSync(path.join(artifacts, 'main-profile-calibration.json'), 'utf8')
    )
    expect(kept.calibration.markers.map((marker: { tag: string }) => marker.tag)).toEqual([
      'start',
      'end'
    ])
    // With whatever marker the phase, or the capture around it, could not take.
    expect(kept.failures).toContain('window_end_marker_failed')
  })

  it('reports shares as unavailable, not as zero, when the profile was never written', async () => {
    const { result, error } = await launchAgents(true, SMALL)
    expect(error).toBeNull()
    const report = (result as { report: Record<string, any> }).report
    expect(report.mainThreadShares).toMatchObject({
      unavailable: 'cpu_profile_unreadable',
      windows: []
    })
  })
})
