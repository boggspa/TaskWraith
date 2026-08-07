/**
 * Two-process parallel-mission smoke for 1.9.3 safe-parallelism.
 *
 * Complements WorkspaceLockParallelMission.integration.test.ts (in-process
 * async closures) with real OS processes sharing one durable WAL:
 *   holder acquire → WAL-visible handshake → contender conflict →
 *   holder release → contender resume acquire → ordered audit trail.
 *
 * Success is state-driven (WAL / IPC results), not sleep-based timing.
 */

import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import { decodeWorkspaceLockWal } from './WorkspaceLockWal'

const temporaryRoots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // best-effort cleanup
      }
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

interface WorkerIpcMessage {
  type: 'ready' | 'acquired' | 'conflict' | 'released' | 'error' | 'done'
  role?: 'holder' | 'contender'
  runId?: string
  pid?: number
  ok?: boolean
  reason?: string
  holderRunIds?: string[]
  transitionId?: string
  message?: string
  status?: 'ok' | 'failed'
}

function workerModulePath(): string {
  const resolved = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'WorkspaceLockParallelMissionProcess.worker.ts'
  )
  return process.platform === 'win32' ? pathToFileURL(resolved).href : resolved
}

function jitiRegisterSpecifier(): string {
  // jiti 2 package exports hide subpaths from require.resolve; load the file by package root.
  const require = createRequire(import.meta.url)
  return path.join(path.dirname(require.resolve('jiti/package.json')), 'lib', 'jiti-register.mjs')
}

function makeHarness(): {
  root: string
  userData: string
  workspace: string
  targetPath: string
  identityRegistry: string
  persistence: NodeWorkspaceLockPersistence
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-parallel-process-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  const targetPath = path.join(workspace, 'src', 'shared.ts')
  fs.writeFileSync(targetPath, 'export const n = 1\n')
  const identityRegistry = path.join(root, 'identity-registry.json')
  fs.writeFileSync(identityRegistry, '{}\n')
  temporaryRoots.push(root)
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: userData })
  return { root, userData, workspace, targetPath, identityRegistry, persistence }
}

function walKinds(persistence: NodeWorkspaceLockPersistence): string[] {
  return decodeWorkspaceLockWal(persistence.readEvents().raw).events.map((event) => event.kind)
}

function walHasAcquireForRun(persistence: NodeWorkspaceLockPersistence, runId: string): boolean {
  const state = decodeWorkspaceLockWal(persistence.readEvents().raw)
  return state.events.some((event) => {
    if (event.kind !== 'acquire') return false
    return event.payload.leases.some((lease) => lease.owner.runId === runId)
  })
}

/** Poll durable WAL until holder acquire is visible — handshake is not sleep. */
async function waitForWalAcquire(
  persistence: NodeWorkspaceLockPersistence,
  runId: string,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (walHasAcquireForRun(persistence, runId)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const kinds = walKinds(persistence)
  throw new Error(
    `Timed out waiting for durable WAL acquire for runId=${runId}. kinds=${kinds.join(',')}`
  )
}

function forkWorker(input: {
  role: 'holder' | 'contender'
  userDataRoot: string
  workspacePath: string
  targetPath: string
  runId: string
  lockOwnerId: string
  identityRegistry: string
  holdMs?: number
  retryTimeoutMs?: number
}): {
  child: ChildProcess
  messages: WorkerIpcMessage[]
  waitFor: (type: WorkerIpcMessage['type'], timeoutMs?: number) => Promise<WorkerIpcMessage>
} {
  const argv = [
    `--role=${input.role}`,
    `--userDataRoot=${input.userDataRoot}`,
    `--workspacePath=${input.workspacePath}`,
    `--targetPath=${input.targetPath}`,
    `--runId=${input.runId}`,
    `--lockOwnerId=${input.lockOwnerId}`,
    `--identityRegistry=${input.identityRegistry}`,
    `--holdMs=${input.holdMs ?? 400}`,
    `--retryTimeoutMs=${input.retryTimeoutMs ?? 8_000}`,
    `--laneId=wave-process-${input.role}`,
    `--displayName=Process ${input.role}`
  ]

  const child = fork(workerModulePath(), argv, {
    execArgv: [`--import`, jitiRegisterSpecifier()],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env }
  })
  children.push(child)

  const messages: WorkerIpcMessage[] = []
  const waiters: Array<{
    type: WorkerIpcMessage['type']
    resolve: (message: WorkerIpcMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk))
  })
  child.stdout?.on('data', () => {
    // IPC is the protocol; swallow stdout noise from loaders.
  })

  child.on('message', (raw: unknown) => {
    const message = raw as WorkerIpcMessage
    messages.push(message)
    const pending = waiters.filter((waiter) => waiter.type === message.type)
    for (const waiter of pending) {
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
    for (const waiter of pending) {
      const idx = waiters.indexOf(waiter)
      if (idx >= 0) waiters.splice(idx, 1)
    }
    if (message.type === 'error') {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(message.message || 'worker error'))
      }
    }
  })

  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      const errText = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2_000)
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(
          new Error(
            `worker ${input.role} exited code=${code} signal=${signal ?? ''} stderr=${errText}`
          )
        )
      }
    }
  })

  function waitFor(type: WorkerIpcMessage['type'], timeoutMs = 10_000): Promise<WorkerIpcMessage> {
    const existing = messages.find((message) => message.type === type)
    if (existing) return Promise.resolve(existing)
    return new Promise<WorkerIpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((waiter) => waiter.timer === timer)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(
          new Error(
            `Timed out waiting for worker ${input.role} message type=${type}. ` +
              `seen=${messages.map((m) => m.type).join(',')}`
          )
        )
      }, timeoutMs)
      waiters.push({ type, resolve, reject, timer })
    })
  }

  return { child, messages, waitFor }
}

describe('WorkspaceLockParallelMission process integration', () => {
  it('forks holder then contender against durable WAL: conflict, release, resume, ordered audit', async () => {
    const h = makeHarness()
    const holderRunId = 'run-process-holder'
    const contenderRunId = 'run-process-contender'

    // 1) Fork holder; handshake = WAL-visible acquire (not sleep).
    const holder = forkWorker({
      role: 'holder',
      userDataRoot: h.userData,
      workspacePath: h.workspace,
      targetPath: h.targetPath,
      runId: holderRunId,
      lockOwnerId: 'process-holder',
      identityRegistry: h.identityRegistry,
      // Safety cap only; parent signals release after contender conflict.
      holdMs: 15_000
    })

    const holderReady = await holder.waitFor('ready')
    await waitForWalAcquire(h.persistence, holderRunId)
    const holderAcquired = await holder.waitFor('acquired')
    expect(holderAcquired.ok).toBe(true)

    // 2) Contender first acquire must conflict with holder runId.
    const contender = forkWorker({
      role: 'contender',
      userDataRoot: h.userData,
      workspacePath: h.workspace,
      targetPath: h.targetPath,
      runId: contenderRunId,
      lockOwnerId: 'process-contender',
      identityRegistry: h.identityRegistry,
      retryTimeoutMs: 8_000
    })

    const contenderReady = await contender.waitFor('ready')
    expect(holderReady.pid).toEqual(expect.any(Number))
    expect(contenderReady.pid).toEqual(expect.any(Number))
    expect(contenderReady.pid).not.toBe(holderReady.pid)
    const conflict = await contender.waitFor('conflict')
    expect(conflict.reason).toBe('conflict')
    expect(conflict.holderRunIds).toEqual(expect.arrayContaining([holderRunId]))

    // 3) Signal holder to release (state-driven; holdMs is only a safety cap).
    holder.child.send({ type: 'release' })
    await holder.waitFor('released')
    const contenderAcquired = await contender.waitFor('acquired')
    expect(contenderAcquired.ok).toBe(true)

    await holder.waitFor('done')
    await contender.waitFor('done')

    // 4) WAL audit: boot + ordered acquire → release → acquire.
    const kinds = walKinds(h.persistence)
    expect(kinds).toEqual(expect.arrayContaining(['boot', 'acquire', 'release']))

    const firstAcquire = kinds.indexOf('acquire')
    const release = kinds.indexOf('release', firstAcquire + 1)
    const secondAcquire = kinds.indexOf('acquire', release + 1)
    expect(firstAcquire).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThan(firstAcquire)
    expect(secondAcquire).toBeGreaterThan(release)

    // Confirm acquire events bind to the expected owners in order.
    const acquireRunIds = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
      .events.filter((event) => event.kind === 'acquire')
      .flatMap((event) => event.payload.leases.map((lease) => lease.owner.runId))
    expect(acquireRunIds[0]).toBe(holderRunId)
    expect(acquireRunIds).toContain(contenderRunId)
  }, 30_000)
})
