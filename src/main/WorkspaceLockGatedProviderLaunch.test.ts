import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockGatedProviderLaunch,
  type WorkspaceLockGatedProviderLaunchDependencies
} from './WorkspaceLockGatedProviderLaunch'
import type { WorkspaceLockProviderAdmission } from './WorkspaceLockProviderCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function admission(
  lifecycle: 'launching-child' | 'child',
  pid: number
): WorkspaceLockProviderAdmission {
  return {
    runId: 'grok-run',
    owner: {
      lockOwnerId: 'exact-owner',
      runId: 'grok-run',
      lifecycle,
      pid,
      processBirthIdentity: `birth-${pid}`
    },
    transitionId: lifecycle === 'child' ? 'transfer' : 'acquire',
    workspacePath: '/workspace',
    worktreePath: '/workspace'
  }
}

function harness(options: { processTreeStopped?: boolean } = {}) {
  const gateChild = new EventEmitter() as ChildProcess
  Object.assign(gateChild, {
    pid: 44,
    kill: vi.fn(() => true)
  })
  const gate = { child: gateChild, start: vi.fn() }
  const transfer = deferred<WorkspaceLockProviderAdmission>()
  const operation = { operationId: 'operation', finish: vi.fn() }
  const deps: WorkspaceLockGatedProviderLaunchDependencies = {
    getAdmission: vi.fn(() => admission('launching-child', 10)),
    beginLifecycleOperation: vi.fn(() => operation),
    transferToChild: vi.fn(() => transfer.promise),
    releaseSetupFailure: vi.fn(async () => undefined),
    releaseChild: vi.fn(async () => undefined),
    quarantineChildForRecovery: vi.fn(async () => undefined),
    onIntegrityFailure: vi.fn(),
    spawnGatedProcess: vi.fn(() => gate),
    waitForProcessTreeExit: vi.fn(async () => options.processTreeStopped ?? true)
  }
  const launch = new WorkspaceLockGatedProviderLaunch({ runId: 'grok-run' }, 'Grok', deps)
  return { launch, deps, gate, gateChild, transfer, operation }
}

const spec = {
  command: '/usr/bin/grok',
  args: ['agent', 'stdio'],
  cwd: '/workspace',
  env: {},
  detached: true
}

describe('WorkspaceLockGatedProviderLaunch', () => {
  it('keeps provider code inert until durable transfer and releases after proven tree exit', async () => {
    const h = harness({ processTreeStopped: true })

    h.launch.spawn(spec)
    expect(h.gate.start).not.toHaveBeenCalled()
    h.transfer.resolve(admission('child', 44))
    await vi.waitFor(() => expect(h.gate.start).toHaveBeenCalledOnce())
    expect(h.operation.finish).toHaveBeenCalledOnce()

    h.gateChild.emit('close', 0, null)
    await h.launch.awaitChildSettlement()

    expect(h.deps.releaseChild).toHaveBeenCalledWith(
      { runId: 'grok-run' },
      expect.objectContaining({ owner: expect.objectContaining({ lifecycle: 'child', pid: 44 }) })
    )
    expect(h.deps.quarantineChildForRecovery).not.toHaveBeenCalled()
    expect(h.deps.onIntegrityFailure).not.toHaveBeenCalled()
  })

  it('moves an unproven descendant tree straight to signed recovery', async () => {
    const h = harness({ processTreeStopped: false })

    h.launch.spawn(spec)
    h.transfer.resolve(admission('child', 44))
    await vi.waitFor(() => expect(h.gate.start).toHaveBeenCalledOnce())
    h.gateChild.emit('close', 1, null)
    await h.launch.awaitChildSettlement()

    expect(h.deps.releaseChild).not.toHaveBeenCalled()
    expect(h.deps.quarantineChildForRecovery).toHaveBeenCalledOnce()
    expect(h.deps.onIntegrityFailure).not.toHaveBeenCalled()
  })

  it('never starts provider code when transfer fails and releases the closed inert guardian', async () => {
    const h = harness()
    vi.mocked(h.gateChild.kill).mockImplementation(() => {
      queueMicrotask(() => h.gateChild.emit('close', null, 'SIGKILL'))
      return true
    })

    h.launch.spawn(spec)
    h.transfer.reject(new Error('durable transfer failed'))

    await expect(h.launch.awaitChildSettlement()).rejects.toThrow('durable transfer failed')
    expect(h.gate.start).not.toHaveBeenCalled()
    expect(h.deps.releaseSetupFailure).toHaveBeenCalledOnce()
    expect(h.deps.releaseChild).not.toHaveBeenCalled()
    expect(h.deps.onIntegrityFailure).toHaveBeenCalledWith(
      expect.stringContaining('durable transfer failed')
    )
  })

  it('releases a pre-spawn guardian on every no-child return path', async () => {
    const h = harness()

    await h.launch.releaseIfUnspawned()
    await h.launch.releaseIfUnspawned()

    expect(h.deps.releaseSetupFailure).toHaveBeenCalledOnce()
    expect(h.operation.finish).toHaveBeenCalledOnce()
  })
})
