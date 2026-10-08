import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { HostProjectionClient } from '../host-client/HostProjectionClient'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  type HostActorIdentity,
  type HostCommand
} from '../shared/hostProtocol'
import {
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { publishHostThreadRecordTransfer } from '../host-runtime/HostThreadRecordTransfer'
import { TASKWRAITH_HOST_QUEUED_START_ENV } from './HostNodeDomainPorts'

interface Occupancy {
  readonly inflight: number
  readonly queued: number
}

type FixtureMessage =
  | { readonly type: 'ready' }
  | ({ readonly type: 'occupancy' } & Occupancy)
  | { readonly type: 'released'; readonly commandId: string }
  | { readonly type: 'stopped' }
  | { readonly type: 'fatal'; readonly message: string }

const paths: string[] = []

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

function command(
  actor: HostActorIdentity,
  name: HostCommand['name'],
  id: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: id,
    idempotencyKey: `key-${id}`,
    actor: { ...actor },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-09-19T00:00:00.000Z'
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  fatal: () => string | null,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fatalMessage = fatal()
    if (fatalMessage)
      throw new Error(`Interference child failed while waiting for ${label}: ${fatalMessage}`)
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(
      () => reject(new Error('HostQueuedStartInterference child did not exit')),
      timeoutMs
    )
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('HostQueuedStartInterference subprocess', () => {
  it('persists an unrelated Desktop record while the real Host holds 16 starts and queues the 17th', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-queued-start-interference-'))
    paths.push(root)
    const outDir = join(root, 'out')
    const profile = join(root, 'profile')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)

    const compile = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        outDir
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0)

    const workers = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
        '--outdir',
        join(outDir, 'host-node')
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(workers.status, workers.stderr).toBe(0)

    const childScript = join(outDir, 'host-node', 'HostQueuedStartInterference.child.js')
    buildSync({
      entryPoints: [
        join(process.cwd(), 'src', 'host-node', 'HostQueuedStartInterference.child.ts')
      ],
      outfile: childScript,
      bundle: false,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      sourcemap: false
    })
    expect(existsSync(childScript)).toBe(true)

    const child = fork(childScript, [profile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [TASKWRAITH_HOST_QUEUED_START_ENV]: '1',
        PATH: ''
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages: FixtureMessage[] = []
    let fatalMessage: string | null = null
    let occupancy: Occupancy | null = null
    let childStderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (childStderr.length < 64 * 1024) childStderr += chunk
    })
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return
      const typed = message as FixtureMessage
      messages.push(typed)
      if (typed.type === 'fatal') fatalMessage = typed.message
      if (typed.type === 'occupancy') {
        occupancy = { inflight: typed.inflight, queued: typed.queued }
      }
    })

    const localActor = {
      actorId: 'host-interference-client',
      clientId: 'host-interference-client',
      clientClass: 'test'
    } as const satisfies HostActorIdentity
    let client: HostProjectionClient | null = null
    let desktop: HostProjectionClient | null = null
    let bodyFailure: unknown = null
    let cleanupFailure: unknown = null

    try {
      await waitFor(
        () =>
          messages.some((message) => message.type === 'ready') &&
          existsSync(taskWraithHostDiscoveryPath(profile)) &&
          existsSync(taskWraithHostTokenPath(profile)),
        'real Host socket',
        () => fatalMessage
      )

      client = new HostProjectionClient({
        userDataPath: profile,
        client: { ...localActor, clientVersion: '1.0' },
        capabilities: [
          'bootstrap',
          'commands',
          'receipts',
          'setup',
          'provider-catalog',
          'snapshot',
          'history',
          'health'
        ]
      })
      await client.connect()

      desktop = new HostProjectionClient({
        userDataPath: profile,
        client: { ...TASKWRAITH_DESKTOP_HOST_ACTOR, clientVersion: '1.0' },
        capabilities: [...TASKWRAITH_DESKTOP_HOST_CAPABILITIES]
      })
      await desktop.connect()

      const workspaceReceipt = await client.submitCommand(
        command(localActor, 'workspace.register', 'interference-workspace', {}, { path: workspace })
      )
      expect(workspaceReceipt.status).toBe('succeeded')
      if (workspaceReceipt.resultRef?.kind !== 'workspace') {
        throw new Error('workspace.register did not return a workspace id')
      }
      const workspaceId = workspaceReceipt.resultRef.workspaceId
      const threadIds: string[] = []
      for (let index = 0; index < 18; index += 1) {
        const receipt = await client.submitCommand(
          command(
            localActor,
            'thread.create',
            `interference-thread-${index + 1}`,
            {},
            { scope: 'workspace', workspaceId }
          )
        )
        expect(receipt.status).toBe('succeeded')
        if (receipt.resultRef?.kind !== 'thread') {
          throw new Error(`thread.create ${index + 1} did not return a thread id`)
        }
        threadIds.push(receipt.resultRef.threadId)
      }

      const offers = await client.getProviderOffers('muse')
      for (let index = 0; index < 17; index += 1) {
        await expect(
          client.submitCommand(
            command(
              localActor,
              'thread.configure',
              `interference-configure-${index + 1}`,
              { threadId: threadIds[index]! },
              {
                providerId: 'muse',
                modelId: 'muse-spark-1.2',
                postureId: 'default',
                offerRevision: offers.offerRevision
              }
            )
          )
        ).resolves.toMatchObject({ status: 'succeeded' })
      }

      const heldCommandIds = Array.from(
        { length: 16 },
        (_, index) => `interference-run-${index + 1}`
      )
      for (let index = 0; index < heldCommandIds.length; index += 1) {
        await client.submitCommand(
          command(
            localActor,
            'composer.send',
            heldCommandIds[index]!,
            { threadId: threadIds[index]! },
            { text: `held run ${index + 1}` }
          )
        )
      }
      await waitFor(
        () => occupancy?.inflight === 16 && occupancy.queued === 0,
        '16 admitted starts',
        () => fatalMessage
      )

      const queuedCommandId = 'interference-run-17'
      await client.submitCommand(
        command(
          localActor,
          'composer.send',
          queuedCommandId,
          { threadId: threadIds[16]! },
          { text: 'queued run 17' }
        )
      )
      await waitFor(
        () => occupancy?.inflight === 16 && occupancy.queued === 1,
        'positive 16+1 admission witness',
        () => fatalMessage
      )
      await expect(client.lookupReceipt({ commandId: queuedCommandId })).resolves.toMatchObject({
        status: 'pending',
        phase: 'queued'
      })
      const queuedSnapshot = await client.getSnapshot()
      const queuedThread = queuedSnapshot.snapshot.threads.find(
        (thread) => thread.id === threadIds[16]
      )
      expect(queuedThread).toBeDefined()

      const persistThreadId = threadIds[17]!
      const recordPath = join(profile, 'chats', `${persistThreadId}.json`)
      const currentRecord = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
      const expectedRevision =
        typeof currentRecord.persistenceRevision === 'number'
          ? currentRecord.persistenceRevision
          : 0
      const persistedTitle = 'Persisted while the 17th start was capacity-queued'
      const persistedRecord = {
        ...currentRecord,
        title: persistedTitle,
        persistenceRevision: expectedRevision + 1,
        updatedAt: Date.now()
      }
      const descriptor = publishHostThreadRecordTransfer({
        profilePath: profile,
        transferId: 'interference-persist-transfer',
        record: persistedRecord
      })
      const persistReceipt = await desktop.submitCommand(
        command(
          TASKWRAITH_DESKTOP_HOST_ACTOR,
          'thread.record.persist',
          'interference-persist',
          { threadId: persistThreadId },
          { ...descriptor, expectedRevision }
        )
      )
      expect(persistReceipt).toMatchObject({
        status: 'succeeded',
        resultSummary: 'thread_record_persisted'
      })

      // This raw file read is the durability witness. It occurs before any
      // provider release and is independent of Host projection/receipt state.
      const durableRecord = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
      expect(durableRecord).toMatchObject({
        appChatId: persistThreadId,
        title: persistedTitle,
        persistenceRevision: expectedRevision + 1
      })
      expect(occupancy).toEqual({ inflight: 16, queued: 1 })

      child.send({ type: 'release', commandId: heldCommandIds[0] })
      await waitFor(
        () =>
          messages.some(
            (message) => message.type === 'released' && message.commandId === heldCommandIds[0]
          ),
        'deterministic provider release',
        () => fatalMessage
      )
      await waitFor(
        () => occupancy?.inflight === 16 && occupancy.queued === 0,
        '17th start admission after release',
        () => fatalMessage
      )
      await waitFor(
        async () => {
          const snapshot = await client!.getSnapshot()
          return snapshot.snapshot.runs.some(
            (run) => run.runId === queuedCommandId && run.providerOutcome === 'running'
          )
        },
        '17th run projection',
        () => fatalMessage
      )
      const admittedSnapshot = await client.getSnapshot()
      const admittedThread = admittedSnapshot.snapshot.threads.find(
        (thread) => thread.id === threadIds[16]
      )
      expect(admittedThread?.messageCount).toBeGreaterThan(queuedThread!.messageCount)
      // Run projection precedes the durable receipt's final acknowledgement.
      await waitFor(
        async () =>
          (await client!.lookupReceipt({ commandId: queuedCommandId })).phase === 'started',
        '17th start receipt',
        () => fatalMessage
      )
      const admittedReceipt = await client.lookupReceipt({ commandId: queuedCommandId })
      expect(admittedReceipt.phase).toBe('started')
      expect(admittedReceipt.status, JSON.stringify(admittedReceipt, null, 2)).toBe('succeeded')
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      client?.close()
      desktop?.close()
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.connected) child.send({ type: 'stop' })
          await waitForExit(child)
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          await waitForExit(child).catch(() => undefined)
          if (bodyFailure === null) cleanupFailure = error
          else
            console.error(
              `[HostQueuedStartInterference] cleanup failed after body error: ${String(error)}\n${childStderr}`
            )
        }
      }
    }

    if (cleanupFailure) throw cleanupFailure
    expect(child.exitCode, childStderr).toBe(0)
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
  }, 90_000)
})
