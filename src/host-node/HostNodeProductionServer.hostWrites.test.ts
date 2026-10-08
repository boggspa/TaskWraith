/**
 * The production Host's own writes to a thread's full copy, with the thread
 * log authority switch on and off: a real profile store and domain, fake
 * providers, and commands sent the way the composition sends them. On, each
 * write asks the thread owner registry first: a thread an app process holds
 * is refused as busy, one whose ended writer left work above the full copy is
 * refused until the Host can fold it, and the rest are written as before.
 * Off, nothing changes.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ThreadAuthorityFiles,
  threadAuthorityDirectory,
  threadAuthorityFilePath
} from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION
} from '../host-shared/thread-log/ThreadLogBatch'
import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import type { HostCommandExecutionResult } from '../host-runtime/HostCommandExecutionResult'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import { HostProfileDomainStore } from '../host-runtime/HostProfileDomainStore'
import type { HostStandaloneCompositionInput } from '../host-runtime/HostStandaloneComposition'
import type { HostThreadOwnerService } from '../host-runtime/HostThreadOwnerService'
import type { MuseRunOutcome } from '../main/muse/MuseRun'
import {
  museMeterSnapshotToProviderStats,
  unavailableMuseMeterSnapshot
} from '../main/muse/MuseUsage'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import { createHostNodeMuseProviderFactory } from './HostNodeMuseProvider'
import { HostNodeProductionServer } from './HostNodeProductionServer'
import type { HostNodeProvider } from './HostNodeProvider'
import { createHostNodeRunAdmission, type HostNodeRunAdmission } from './HostNodeRunAdmission'

const TEMPORARY_PREFIX = 'host-node-host-writes-'
const AT = Date.UTC(2026, 9, 5, 10, 0, 0)
const STAMP = '2026-10-05T10:00:00.000Z'
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const ON = { [THREAD_LOG_AUTHORITY_ENV]: '1' }
// The switch is on by default; only the exact token `0` turns it off.
const OFF = { [THREAD_LOG_AUTHORITY_ENV]: '0' }
const actor = { actorId: 'actor-1', clientId: 'tui-1', clientClass: 'tui' as const }
const context = {
  actor,
  client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
}
const phone = {
  actor: { actorId: 'phone-1', clientId: 'phone-1', clientClass: 'ios' as const },
  client: { clientId: 'phone-1', clientClass: 'ios' as const, clientVersion: '1.0.0' }
}
const STALE_OFFER_NOTICE =
  'Provider catalogue refresh failed · this send was validated against the last known offer set.'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  rmSync(directory, { recursive: true, force: true })
}

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) removeTemporaryDirectory(folder)
})

function outcome(status: MuseRunOutcome['status']): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot(SESSION_ID)
  return {
    status,
    sessionId: SESSION_ID,
    exitCode: status === 'success' ? 0 : null,
    assistantText: status === 'success' ? 'Muse answer' : '',
    events: [],
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings: [],
    argv: ['exec', '--json'],
    effort: 'high',
    writeCapable: true,
    skillPinHash: 'a'.repeat(64),
    leasePath: '/tmp/muse-lease'
  }
}

const museOffers = {
  providerId: 'muse' as const,
  offerRevision: 'muse-offer-1',
  models: [
    {
      modelId: 'muse-spark-1.2',
      label: 'Muse Spark',
      available: true,
      default: true,
      reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
    },
    {
      modelId: 'muse-flow-2',
      label: 'Muse Flow',
      available: true,
      reasoning: [{ reasoningId: 'low', label: 'Low', available: true }]
    }
  ],
  postures: [
    {
      postureId: 'default',
      label: 'Default',
      available: true,
      requiresExplicitConsent: false,
      ceiling: 'workspace_write' as const
    }
  ]
}

let commandCount = 0
function command(
  name: HostCommand['name'],
  target: Record<string, string>,
  arguments_: Record<string, unknown>,
  by: typeof actor | typeof phone.actor = actor
): HostCommand {
  commandCount += 1
  const commandId = `00000000-0000-4000-8000-${String(commandCount).padStart(12, '0')}`
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `key-${commandId}`,
    actor: by,
    name,
    target,
    arguments: arguments_,
    issuedAt: STAMP
  }
}

/** Provider runs the test has not yet let end; once closing, none waits. */
interface HeldRuns {
  readonly waiting: Array<() => void>
  closing: boolean
}

function held(runs: HeldRuns): Promise<void> {
  return runs.closing ? Promise.resolve() : new Promise((resolve) => runs.waiting.push(resolve))
}

/** Muse as a CLI would run it, whose runs end when the test lets them. */
function museCli(workspace: () => string, runs: HeldRuns): HostNodeProvider {
  return createHostNodeMuseProviderFactory({
    offers: museOffers,
    resources: {
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/muse' }),
      getTemporaryRoot: () => '/tmp',
      readAuthJsonText: async () => null,
      readMetaApiKeyEnv: () => 'env-muse-secret',
      spawn: () => ({ pid: 4242, kill: () => true }) as never
    },
    now: () => AT,
    createSessionId: () => SESSION_ID,
    runMuseProvider: async (input) => {
      input.spawn({ binaryPath: '/usr/local/bin/muse', argv: [], cwd: workspace(), env: {} })
      await held(runs)
      return outcome('success')
    }
  })
}

/** A Muse whose catalogue can stop refreshing, and whose runs end when the test lets them. */
function museWithOffers(state: { offersFail: boolean }, runs: HeldRuns): HostNodeProvider {
  return {
    providerId: 'muse',
    displayProvider: 'Muse',
    shortCode: 'MUSE',
    offers: museOffers,
    supportsApprovals: false,
    supportsQuestions: false,
    create: ({ runPort }) => ({
      providerId: 'muse',
      getOffers: async () => {
        if (state.offersFail) throw new Error('daemon unreachable')
        return museOffers
      },
      getStatus: async () => ({ providerId: 'muse', status: 'ready', label: 'Muse' }),
      getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
      getAuthFlows: async () => [],
      beginAuth: async () => undefined,
      cancelAuth: async () => false,
      run: async (input) => {
        runPort.beginRun({
          runId: input.runId,
          threadId: input.threadId,
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          startedAt: STAMP
        })
        runPort.appendTranscript({
          threadId: input.threadId,
          runId: input.runId,
          role: 'user',
          text: input.prompt,
          createdAt: STAMP
        })
        await held(runs)
        runPort.finishRun({
          runId: input.runId,
          status: 'completed',
          finishedAt: STAMP,
          warningSummaries: []
        })
        return { runId: input.runId, status: 'completed', sessionId: SESSION_ID, exitCode: 0 }
      },
      cancel: () => true,
      shutdown: async () => undefined
    })
  } as HostNodeProvider
}

/**
 * The production server over a real profile store and domain, with a fake
 * composition and listener that keep what they are built with.
 */
function harness(
  environment: Record<string, string>,
  options: {
    readonly provider?: (workspace: () => string, runs: HeldRuns) => HostNodeProvider
    readonly runAdmission?: HostNodeRunAdmission
    /** Take the profile as production does, with this thread catalogue, instead of a stub lease. */
    readonly catalogue?: unknown
  } = {}
) {
  const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  const workspace = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  folders.push(profile, workspace)
  let compositionInput: HostStandaloneCompositionInput | undefined
  let listenerInput: HostLocalServerOptions | undefined
  let store: HostProfileDomainStore | undefined
  let ids = 0
  commandCount = 0
  const runs: HeldRuns = { waiting: [], closing: false }
  const composition = {
    authority: {},
    session: {},
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: {
        process: 'host' as const,
        instanceId: 'host',
        generation: 0,
        pid: process.pid,
        bootEpoch: 'f'.repeat(64)
      }
    },
    recoverQueuedStarts: vi.fn(async () => undefined),
    startProjectionReconciliation: vi.fn(async () => undefined),
    reconcileProjection: vi.fn(async () => undefined),
    subscribeDeltas: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => undefined)
  }
  const server = new HostNodeProductionServer({
    profilePath: profile,
    mode: 'production',
    environment,
    domainOptions: {
      providers: [(options.provider ?? museCli)(() => workspace, runs)],
      health: () => ({
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      }),
      now: () => AT,
      ...(options.runAdmission ? { runAdmission: options.runAdmission } : {})
    } as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    ...(options.catalogue
      ? { createThreadCatalogue: () => options.catalogue as never }
      : {
          acquireLease: () => ({ path: profile, assertHeld: () => undefined, release: () => true })
        }),
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }),
    createStore: (input) =>
      (store = new HostProfileDomainStore({
        ...input,
        now: () => AT,
        idFactory: () => `id-${++ids}`
      })),
    createComposition: (input) => {
      compositionInput = input
      return composition as never
    },
    createListener: (input) => {
      listenerInput = input
      return {
        socketPath: path.join(profile, 'host.sock'),
        discoveryPath: path.join(profile, 'host.json'),
        startedAt: STAMP,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      } as never
    }
  })
  const setupNames = new Set([
    'workspace.register',
    'thread.create',
    'thread.configure',
    'thread.archive'
  ])
  /** As the composition sends it: setup commands to the setup executor, the rest to the domain. */
  const send = async (
    candidate: HostCommand,
    as: typeof context | typeof phone = context
  ): Promise<HostCommandExecutionResult> => {
    const input = compositionInput!
    return setupNames.has(candidate.name)
      ? input.setupExecutor!.execute(candidate, as)
      : input.commandExecutor!(candidate, as)
  }
  return {
    server,
    profile,
    workspace,
    send,
    store: () => store!,
    owners: () => listenerInput!.threadOwners as HostThreadOwnerService,
    sections: () =>
      compositionInput!.perf!.instrumentation!.snapshot().sections as Record<
        string,
        Record<string, unknown> | undefined
      >,
    /** Runs the provider has started and the test has not yet let end. */
    waitingRuns: () => runs.waiting.length,
    /** Let every run waiting so far end. */
    endRuns: () => {
      for (const end of runs.waiting.splice(0)) end()
    },
    /** Lets every run end, now and later, and stops the server. */
    stop: async () => {
      runs.closing = true
      for (const end of runs.waiting.splice(0)) end()
      await server.stop()
    }
  }
}

type Harness = ReturnType<typeof harness>

const workspaceIds = new WeakMap<Harness, string>()

/** A workspace thread on Muse, as a client makes one. */
async function museThread(h: Harness): Promise<string> {
  let workspaceId = workspaceIds.get(h)
  if (!workspaceId) {
    const registered = await h.send(command('workspace.register', {}, { path: h.workspace }))
    workspaceId = (registered.resultRef as { workspaceId: string }).workspaceId
    workspaceIds.set(h, workspaceId)
  }
  const created = await h.send(command('thread.create', {}, { scope: 'workspace', workspaceId }))
  const threadId = (created.resultRef as { threadId: string }).threadId
  expect(
    await h.send(
      command(
        'thread.configure',
        { threadId },
        {
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          reasoningId: 'high',
          postureId: 'default',
          offerRevision: 'muse-offer-1'
        }
      )
    )
  ).toMatchObject({ status: 'succeeded' })
  return threadId
}

/** An ensemble thread on Muse, and the participant a seat toggle would turn off. */
async function ensembleThread(h: Harness): Promise<{ threadId: string; participantId: string }> {
  const threadId = await museThread(h)
  expect(
    await h.send(command('thread.configure', { threadId }, { chatKind: 'ensemble' }))
  ).toMatchObject({ status: 'succeeded' })
  const ensemble = h.store().getThread(threadId)!.ensemble as {
    participants: Array<{ id: string }>
  }
  expect(ensemble.participants.length).toBeGreaterThan(1)
  return { threadId, participantId: ensemble.participants[0]!.id }
}

/** The thread's authority file, naming a writer with this process id. */
async function owned(h: Harness, threadId: string, pid: number): Promise<void> {
  await new ThreadAuthorityFiles(h.profile).write({
    threadId,
    writer: { writerId: 'desk-1', pid },
    epoch: { host: 'e'.repeat(64), grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 1
  })
}

function authorityFileThere(h: Harness, threadId: string): boolean {
  return existsSync(threadAuthorityFilePath(h.profile, threadId))
}

/** A log for the thread whose last line is at `revision`. */
function logAt(h: Harness, threadId: string, revision: number): void {
  const directory = path.join(h.profile, 'chat-journal-v2')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, `${threadId}.mutations.jsonl`),
    `${JSON.stringify({
      format: THREAD_LOG_BATCH_FORMAT,
      version: THREAD_LOG_BATCH_VERSION,
      chatId: threadId,
      baseRevision: revision - 1,
      revision,
      savedAt: STAMP,
      operations: []
    })}\n`
  )
}

/** A process id that was in use and no longer is. */
function endedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

function revisionOf(h: Harness, threadId: string): number {
  return h.store().threadRecordState(threadId)!.revision
}

async function settled(h: Harness, threadId: string): Promise<void> {
  await vi.waitFor(() =>
    expect(
      (h.store().getThread(threadId)?.runs ?? []).every((run) => run.status !== 'running')
    ).toBe(true)
  )
}

/**
 * Runs, renames and archives a thread, the way a client would: what the Host
 * answers, and the thread as it is left. With `holder`, the thread's
 * authority file names a writer with that process id first.
 */
async function sendConfigureArchive(
  h: Harness,
  holder?: number
): Promise<{ readonly answers: unknown[]; readonly thread: unknown }> {
  const threadId = await museThread(h)
  if (holder !== undefined) await owned(h, threadId, holder)
  const answers: unknown[] = []
  answers.push(await h.send(command('composer.send', { threadId }, { text: 'Run it' })))
  await vi.waitFor(() => expect(h.waitingRuns()).toBe(1))
  h.endRuns()
  await settled(h, threadId)
  answers.push(await h.send(command('thread.configure', { threadId }, { title: 'Renamed' })))
  answers.push(await h.send(command('thread.archive', { threadId }, { archived: true })))
  return { answers, thread: h.store().getThread(threadId) }
}

/** The sha256 of a value, with the workspace's temporary path made constant. */
function digest(h: Harness, value: unknown): string {
  const workspace = realpathSync(h.workspace)
  const text = JSON.stringify(value, (_key, entry) =>
    entry === h.workspace || entry === workspace ? '<workspace>' : entry
  )
  return createHash('sha256').update(text).digest('hex')
}

/**
 * What the Host answered and left with the switch off, over a thread whose
 * authority file names a live writer, captured from the Host as it was
 * before its writes asked the registry: the sha256 of the answers and the
 * thread's record.
 */
const OFF_GOLDEN = '7e31f1d930cacd0acee8aaf3bbbe8b3de749809b65272febf62fffd0986d1e37'

const busy = {
  status: 'failed',
  errorCode: 'thread_busy_in_desktop',
  errorMessage: expect.stringContaining('desktop app')
}
const foldFirst = {
  status: 'failed',
  errorCode: 'thread_fold_first',
  errorMessage: expect.stringContaining('desktop app')
}

describe('HostNodeProductionServer: its own writes to a thread', () => {
  it('off, writes a thread whatever its authority file says, as before', async () => {
    const h = harness(OFF)
    await h.server.start()
    try {
      const written = await sendConfigureArchive(h, process.pid)
      expect(written.answers).toEqual([
        { status: 'succeeded', resultSummary: 'run_started' },
        { status: 'succeeded', resultRef: { kind: 'thread', threadId: 'id-2' } },
        { status: 'succeeded', resultRef: { kind: 'thread', threadId: 'id-2' } }
      ])
      const golden = digest(h, written)
      const out = process.env.HOST_WRITES_GOLDEN_OUT
      if (out) writeFileSync(out, `${golden}\n${JSON.stringify(written, null, 1)}\n`)
      expect(golden).toBe(OFF_GOLDEN)
      expect(h.sections().threadWrites).toBeUndefined()
    } finally {
      await h.stop()
    }
  })

  it('on, writes a thread nobody holds exactly as off does', async () => {
    const digests: string[] = []
    for (const environment of [OFF, ON]) {
      const h = harness(environment)
      await h.server.start()
      try {
        digests.push(digest(h, await sendConfigureArchive(h)))
      } finally {
        await h.stop()
      }
    }
    expect(digests[1]).toBe(digests[0])
  })

  it('on, refuses a send, a configuration, an archive and a seat toggle on a thread a live app process holds, and leaves it as it was', async () => {
    const h = harness(ON)
    await h.server.start()
    try {
      const threadId = await museThread(h)
      const ensemble = await ensembleThread(h)
      await owned(h, threadId, process.pid)
      await owned(h, ensemble.threadId, process.pid)
      const before = [h.store().getThread(threadId), h.store().getThread(ensemble.threadId)]

      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual(busy)
      expect(
        await h.send(
          command(
            'composer.send',
            { threadId },
            { text: 'Run it', model: 'muse-flow-2', reasoningEffort: 'low' }
          )
        )
      ).toEqual(busy)
      expect(await h.send(command('thread.configure', { threadId }, { title: 'Renamed' }))).toEqual(
        busy
      )
      expect(await h.send(command('thread.archive', { threadId }, { archived: true }))).toEqual(
        busy
      )
      expect(
        await h.send(
          command(
            'ensemble.seat.toggle',
            { threadId: ensemble.threadId },
            { participantId: ensemble.participantId, enabled: false }
          )
        )
      ).toEqual(busy)

      expect([h.store().getThread(threadId), h.store().getThread(ensemble.threadId)]).toEqual(
        before
      )
      expect(h.waitingRuns()).toBe(0)
      expect(authorityFileThere(h, threadId)).toBe(true)
      expect(authorityFileThere(h, ensemble.threadId)).toBe(true)
      expect(h.sections().threadWrites).toMatchObject({
        refused: { busy: 5, foldFirst: 0, askRelease: 0, failed: 0 },
        paths: {
          'composer.send': { asked: 2, refused: 2 },
          'thread.configure': { refused: 1 },
          'thread.archive': { asked: 1, refused: 1 },
          'ensemble.seat.toggle': { asked: 1, refused: 1 }
        },
        live: 0
      })
    } finally {
      await h.stop()
    }
  })

  it('on, toggles a seat on a thread nobody holds, and holds the thread no longer than the write', async () => {
    const h = harness(ON)
    await h.server.start()
    try {
      const ensemble = await ensembleThread(h)
      expect(
        await h.send(
          command(
            'ensemble.seat.toggle',
            { threadId: ensemble.threadId },
            { participantId: ensemble.participantId, enabled: false }
          )
        )
      ).toEqual({ status: 'succeeded', resultSummary: 'ensemble_seat_disabled' })
      const participants = (
        h.store().getThread(ensemble.threadId)!.ensemble as {
          participants: Array<{ id: string; enabled: boolean }>
        }
      ).participants
      expect(participants.find((seat) => seat.id === ensemble.participantId)?.enabled).toBe(false)
      expect(h.sections().threadWrites).toMatchObject({
        paths: { 'ensemble.seat.toggle': { asked: 1, refused: 0 } },
        live: 0
      })
    } finally {
      await h.stop()
    }
  })

  it('on, refuses them as fold_first when the writer has ended and its log leads the full copy', async () => {
    const h = harness(ON)
    await h.server.start()
    try {
      const threadId = await museThread(h)
      await owned(h, threadId, endedPid())
      logAt(h, threadId, revisionOf(h, threadId) + 2)
      const before = h.store().getThread(threadId)

      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual(
        foldFirst
      )
      expect(await h.send(command('thread.configure', { threadId }, { title: 'Renamed' }))).toEqual(
        foldFirst
      )
      expect(await h.send(command('thread.archive', { threadId }, { archived: true }))).toEqual(
        foldFirst
      )

      expect(h.store().getThread(threadId)).toEqual(before)
      expect(h.waitingRuns()).toBe(0)
      expect(authorityFileThere(h, threadId)).toBe(true)
      expect(h.sections().threadWrites).toMatchObject({
        refused: { busy: 0, foldFirst: 3, askRelease: 0, failed: 0 }
      })
    } finally {
      await h.stop()
    }
  })

  it('on, takes the file of an ended writer with nothing left to fold, and writes', async () => {
    const h = harness(ON)
    await h.server.start()
    try {
      const threadId = await museThread(h)
      await owned(h, threadId, endedPid())
      logAt(h, threadId, revisionOf(h, threadId))

      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual({
        status: 'succeeded',
        resultSummary: 'run_started'
      })
      expect(authorityFileThere(h, threadId)).toBe(false)
      h.endRuns()
      await settled(h, threadId)
    } finally {
      await h.stop()
    }
  })

  it('on, never writes over a file it cannot take away, and counts it', async () => {
    const h = harness(ON)
    await h.server.start()
    const directory = threadAuthorityDirectory(h.profile)
    try {
      const threadId = await museThread(h)
      await owned(h, threadId, endedPid())
      const before = h.store().getThread(threadId)
      chmodSync(directory, 0o500)

      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual(busy)
      expect(h.store().getThread(threadId)).toEqual(before)
      expect(h.sections().threadOwners?.authority).toMatchObject({
        removeFailures: 1,
        lastRemoveError: expect.stringContaining('EACCES')
      })
    } finally {
      chmodSync(directory, 0o700)
      await h.stop()
    }
  })

  it('on, keeps a thread from an app claim from the moment its write is let through until the run it starts ends', async () => {
    const h = harness(ON, { runAdmission: createHostNodeRunAdmission({ maxConcurrentRuns: 1 }) })
    await h.server.start()
    try {
      const first = await museThread(h)
      const second = await museThread(h)
      const claim = (threadId: string, claimId: number) =>
        h.owners().answer(7, {
          action: 'claim',
          threadId,
          writerId: 'desk-1',
          claimId,
          baseRevision: revisionOf(h, threadId),
          headRevision: revisionOf(h, threadId)
        })
      expect(await h.send(command('composer.send', { threadId: first }, { text: 'One' }))).toEqual({
        status: 'succeeded',
        resultSummary: 'run_started'
      })
      // The second send is let through, then waits for the one run the Host may hold.
      const sent = h.send(command('composer.send', { threadId: second }, { text: 'Two' }))
      await vi.waitFor(() =>
        expect(h.sections().threadWrites).toMatchObject({
          paths: { 'composer.send': { asked: 2 } },
          live: 1
        })
      )
      expect(await claim(second, 1)).toMatchObject({
        reply: { granted: false, reason: 'host_run_active' }
      })
      h.endRuns()
      expect(await sent).toEqual({ status: 'succeeded', resultSummary: 'run_started' })
      await settled(h, first)
      expect(await claim(second, 2)).toMatchObject({
        reply: { granted: false, reason: 'host_run_active' }
      })
      h.endRuns()
      await settled(h, second)
      expect(await claim(second, 3)).toMatchObject({ reply: { granted: true } })
      expect(h.sections().threadWrites).toMatchObject({ live: 0 })
    } finally {
      await h.stop()
    }
  })

  it('on, writes the notice of a send checked against old offers only when the Host may write the thread', async () => {
    const offers = { offersFail: false }
    const h = harness(ON, { provider: (_workspace, runs) => museWithOffers(offers, runs) })
    await h.server.start()
    try {
      const threadId = await museThread(h)
      await owned(h, threadId, process.pid)
      const before = h.store().getThread(threadId)
      offers.offersFail = true

      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual(busy)
      await new Promise((resolve) => setImmediate(resolve))
      expect(h.store().getThread(threadId)).toEqual(before)

      // The app has let the thread go.
      await new ThreadAuthorityFiles(h.profile).remove(threadId)
      expect(await h.send(command('composer.send', { threadId }, { text: 'Run it' }))).toEqual({
        status: 'succeeded',
        resultSummary: 'run_started'
      })
      const messages = h.store().getThread(threadId)!.messages
      const notice = messages.findIndex((message) => message.content === STALE_OFFER_NOTICE)
      const prompt = messages.findIndex((message) => message.role === 'user')
      expect(notice).toBeGreaterThanOrEqual(0)
      expect(prompt).toBeGreaterThan(notice)
      expect(h.sections().threadWrites).toMatchObject({
        paths: { 'offer.notice': { asked: 2, refused: 1 } }
      })
      h.endRuns()
      await settled(h, threadId)
    } finally {
      await h.stop()
    }
  })

  it('on, asks nothing for a command the Host refuses anyway, such as a phone’s', async () => {
    const h = harness(ON)
    await h.server.start()
    try {
      const threadId = await museThread(h)
      await owned(h, threadId, process.pid)
      const asked = (h.sections().threadWrites as { asked: number }).asked
      expect(
        await h.send(command('composer.send', { threadId }, { text: 'Run it' }, phone.actor), phone)
      ).toMatchObject({ status: 'failed', errorCode: 'authority_denied' })
      expect(
        await h.send(
          command('thread.configure', { threadId }, { title: 'Renamed' }, phone.actor),
          phone
        )
      ).toMatchObject({ status: 'failed', errorCode: 'setup_forbidden' })
      expect(await h.send(command('thread.configure', { threadId }, { title: '' }))).toMatchObject({
        status: 'failed',
        errorCode: 'setup_invalid'
      })
      expect((h.sections().threadWrites as { asked: number }).asked).toBe(asked)
    } finally {
      await h.stop()
    }
  })
})

describe('HostNodeProductionServer: catalogue recovery and its own writes', () => {
  const CHAT = '22222222-2222-4222-8222-222222222222'

  /**
   * A thread catalogue that lists one thread holding a run a former
   * incarnation of this Host left unsettled, and records what it is asked.
   */
  function catalogueWithAnUnsettledRun(asked: string[]) {
    const projection = {
      revision: 1,
      summary: {
        chatId: CHAT,
        title: 'Left running',
        provider: 'muse',
        chatKind: 'single',
        scope: 'global',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        messageCount: 0,
        runCount: 1
      },
      recovery: {
        unsettledRuns: 1,
        ensembleWakeups: 0,
        soloWakeups: 0,
        workerEvents: 0,
        joinPolicies: 0,
        nextBlackboardExpiryAt: null
      }
    }
    return {
      ready: Promise.resolve(),
      query: async (request: { method: string; after?: number }) => {
        asked.push(request.method)
        switch (request.method) {
          case 'changes':
            return { reset: false, changes: [], position: { incarnation: 'test', sequence: 0 } }
          case 'list':
            return {
              entries: [{ projection, sourceWitness: 'witness-1' }],
              next: null,
              coverage: 'complete',
              repairPending: []
            }
          case 'open':
            return {
              leaseId: 'lease-1',
              entry: {
                databaseId: 'database',
                chatId: CHAT,
                generation: 'generation-1',
                sourceWitness: 'witness-1',
                epoch: { global: 'global', chat: 'epoch-1' },
                heads: { desktop: null, host: null },
                projection,
                snapshot: false
              }
            }
          case 'objects':
            return request.after === undefined
              ? [
                  {
                    ordinal: 1,
                    kind: 'inline',
                    value: {
                      kind: 'run',
                      runId: 'run-1',
                      hostRunOrigin: {
                        schemaVersion: 1,
                        kind: 'host-node',
                        hostId: 'host',
                        incarnation: 'earlier'
                      }
                    }
                  }
                ]
              : []
          case 'prepare':
            return null
          default:
            return true
        }
      },
      dispose: async () => undefined
    }
  }

  it('on, settles a former Host’s runs only in a thread the Host may write', async () => {
    for (const held of [true, false]) {
      const asked: string[] = []
      const h = harness(ON, { catalogue: catalogueWithAnUnsettledRun(asked) })
      if (held) await owned(h, CHAT, process.pid)
      await h.server.start()
      try {
        await vi.waitFor(() =>
          expect(h.sections().threadWrites).toMatchObject({
            paths: { 'catalogue.recovery': { asked: 1, refused: held ? 1 : 0 } }
          })
        )
        await vi.waitFor(() => expect(asked).toContain('release'))
        if (held) expect(asked).not.toContain('prepare')
      } finally {
        await h.stop()
      }
    }
  })
})
