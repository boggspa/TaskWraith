import { describe, expect, it, vi } from 'vitest'
import {
  canonicalCursorWorkspaceConfigResource,
  CursorWorkspaceConfigLeaseAbortedError,
  CursorWorkspaceConfigLeaseCoordinator,
  CursorWorkspaceConfigInstallError,
  CursorWorkspaceConfigLeaseReentrancyError,
  CursorWorkspaceConfigLeaseTaintedError,
  cursorWorkspaceConfigurationKey,
  unverifiedCursorWorkspaceConfigRestore
} from './CursorWorkspaceConfigLease'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function verifiedInstallation(cleanup: () => void | Promise<void> = () => undefined) {
  return {
    onLastRelease: async () => {
      await cleanup()
      return { outcome: 'restored-verified' as const }
    }
  }
}

describe('CursorWorkspaceConfigLeaseCoordinator', () => {
  it('shares one installed overlay between compatible concurrent runs', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const restore = vi.fn()
    const install = vi.fn(async () => verifiedInstallation(restore))
    const configurationKey = cursorWorkspaceConfigurationKey('write')

    const first = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install
    })
    const second = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install
    })

    expect(install).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject([
      { activeConfigurationKey: configurationKey, activeHolders: 2 }
    ])
    await first.release()
    expect(restore).not.toHaveBeenCalled()
    await second.release()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toEqual([])
  })

  it('restores before installing an incompatible posture', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const calls: string[] = []
    const first = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => {
        calls.push('install-write')
        return verifiedInstallation(() => {
          calls.push('restore-write')
        })
      }
    })
    const onQueued = vi.fn()
    const readLeasePromise = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      onQueued,
      install: async () => {
        calls.push('install-read')
        return verifiedInstallation(() => {
          calls.push('restore-read')
        })
      }
    })

    await Promise.resolve()
    expect(onQueued).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['install-write'])
    await first.release()
    const readLease = await readLeasePromise
    expect(calls).toEqual(['install-write', 'restore-write', 'install-read'])
    await readLease.release()
    expect(calls).toEqual(['install-write', 'restore-write', 'install-read', 'restore-read'])
  })

  it('does not let compatible arrivals starve an already-queued posture', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const order: string[] = []
    const writeKey = cursorWorkspaceConfigurationKey('write')
    const readKey = cursorWorkspaceConfigurationKey('read-only')
    const activeWrite = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      install: async () =>
        verifiedInstallation(() => {
          order.push('restore-write-1')
        })
    })
    const readPromise = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: readKey,
      install: async () => {
        order.push('install-read')
        return verifiedInstallation(() => {
          order.push('restore-read')
        })
      }
    })
    const laterWritePromise = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      install: async () => {
        order.push('install-write-2')
        return verifiedInstallation()
      }
    })

    await activeWrite.release()
    const read = await readPromise
    expect(order).toEqual(['restore-write-1', 'install-read'])
    await read.release()
    const laterWrite = await laterWritePromise
    expect(order).toEqual(['restore-write-1', 'install-read', 'restore-read', 'install-write-2'])
    await laterWrite.release()
  })

  it('rejects a failed compatible batch and advances the next posture', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const setup = deferred<() => void>()
    const first = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: () => setup.promise,
      onInstallFailure: () => ({ outcome: 'restored-verified' })
    })
    const same = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    const next = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      install: async () => verifiedInstallation()
    })
    setup.reject(new Error('setup failed'))

    await expect(first).rejects.toThrow('setup failed')
    await expect(same).rejects.toThrow('setup failed')
    const nextLease = await next
    await nextLease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('removes an aborted queued request without disturbing the active lease', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    const controller = new AbortController()
    const waiting = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: async () => verifiedInstallation()
    })
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(coordinator.snapshot()).toMatchObject([
      { activeHolders: 1, queuedConfigurationKeys: [] }
    ])
    await active.release()
    await active.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('queues same-posture arrivals while the previous overlay is restoring', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const restoreStarted = deferred<void>()
    const allowRestore = deferred<void>()
    const configurationKey = cursorWorkspaceConfigurationKey('write')
    const first = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install: async () =>
        verifiedInstallation(async () => {
          restoreStarted.resolve(undefined)
          await allowRestore.promise
        })
    })

    const release = first.release()
    await restoreStarted.promise
    const installNext = vi.fn(async () => verifiedInstallation())
    const onQueued = vi.fn()
    const next = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install: installNext,
      onQueued
    })

    expect(onQueued).toHaveBeenCalledTimes(1)
    expect(installNext).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject([
      {
        activeConfigurationKey: null,
        activeHolders: 0,
        installing: false,
        restoring: true,
        queuedConfigurationKeys: [configurationKey]
      }
    ])

    allowRestore.resolve(undefined)
    await release
    const nextLease = await next
    expect(installNext).toHaveBeenCalledTimes(1)
    await nextLease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('freezes an aborted installing batch before awaiting its cleanup', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const configurationKey = cursorWorkspaceConfigurationKey('read-only')
    const installed = deferred<ReturnType<typeof verifiedInstallation>>()
    const restoreStarted = deferred<void>()
    const allowRestore = deferred<void>()
    const controller = new AbortController()
    const first = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      signal: controller.signal,
      install: () => installed.promise
    })

    let rejected = false
    void first.catch(() => {
      rejected = true
    })
    controller.abort()
    await Promise.resolve()
    expect(rejected).toBe(false)
    installed.resolve(
      verifiedInstallation(async () => {
        restoreStarted.resolve(undefined)
        await allowRestore.promise
      })
    )
    await restoreStarted.promise

    const installNext = vi.fn(async () => verifiedInstallation())
    const next = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install: installNext
    })
    expect(installNext).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject([
      {
        installing: true,
        restoring: true,
        queuedConfigurationKeys: [configurationKey]
      }
    ])

    allowRestore.resolve(undefined)
    const aborted = await first.catch((reason: unknown) => reason)
    expect(aborted).toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(aborted).toMatchObject({
      cleanup: { outcome: 'restored-verified' }
    })
    const nextLease = await next
    expect(installNext).toHaveBeenCalledTimes(1)
    await nextLease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('does not let an observational queue callback break arbitration', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    const waiting = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      install: async () => verifiedInstallation(),
      onQueued: () => {
        throw new Error('renderer unavailable')
      }
    })

    await active.release()
    const lease = await waiting
    await lease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('lets a queue callback cancel its own request without leaving stale work', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    const controller = new AbortController()
    const waiting = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: async () => verifiedInstallation(),
      onQueued: () => controller.abort()
    })

    await expect(waiting).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(coordinator.snapshot()).toMatchObject([{ queuedConfigurationKeys: [] }])
    await active.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('admits compatible waiters when an incompatible queue head aborts', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const writeKey = cursorWorkspaceConfigurationKey('write')
    const installWrite = vi.fn(async () => verifiedInstallation())
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      install: installWrite
    })
    const controller = new AbortController()
    const incompatible = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      signal: controller.signal,
      install: async () => verifiedInstallation()
    })
    const compatible = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      install: installWrite
    })

    controller.abort()
    await expect(incompatible).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    const joined = await compatible
    expect(installWrite).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject([{ activeHolders: 2 }])
    await active.release()
    await joined.release()
  })

  it('does not admit a compatible waiter whose shared signal is already aborting', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const writeKey = cursorWorkspaceConfigurationKey('write')
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      install: async () => verifiedInstallation()
    })
    const controller = new AbortController()
    const incompatible = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: async () => verifiedInstallation()
    })
    const compatible = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: writeKey,
      signal: controller.signal,
      install: async () => verifiedInstallation()
    })

    // The incompatible listener runs first and advances the queue while the
    // same signal is still dispatching. Admission must consult live signal
    // state rather than relying only on the compatible listener having fired.
    controller.abort()
    const outcomes = await Promise.all([
      incompatible.catch((reason: unknown) => reason),
      compatible.catch((reason: unknown) => reason)
    ])
    expect(outcomes[0]).toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(outcomes[1]).toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(coordinator.snapshot()).toMatchObject([
      { activeHolders: 1, queuedConfigurationKeys: [] }
    ])

    await active.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('keeps an in-flight abort pending until a compatible installation is stable', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const configurationKey = cursorWorkspaceConfigurationKey('write')
    const installed = deferred<ReturnType<typeof verifiedInstallation>>()
    const controller = new AbortController()
    const restore = vi.fn()
    const cancelled = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      signal: controller.signal,
      install: () => installed.promise
    })
    const admitted = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey,
      install: async () => verifiedInstallation()
    })
    let rejected = false
    void cancelled.catch(() => {
      rejected = true
    })

    controller.abort()
    await Promise.resolve()
    expect(rejected).toBe(false)
    installed.resolve(verifiedInstallation(restore))

    const error = await cancelled.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(error).toMatchObject({ cleanup: null })
    const lease = await admitted
    expect(restore).not.toHaveBeenCalled()
    await lease.release()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('carries all-aborted cleanup failure evidence after quiescence', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const installed = deferred<{
      onLastRelease: () => never
    }>()
    const controller = new AbortController()
    const request = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: () => installed.promise
    })

    controller.abort()
    installed.resolve({
      onLastRelease: () => {
        throw new Error('workspace restore failed')
      }
    })

    const error = await request.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(error).toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: 'workspace restore failed'
      }
    })
    expect(coordinator.snapshot()).toMatchObject([
      {
        cleanupTaint: {
          outcome: 'cleanup-failed',
          message: 'workspace restore failed'
        }
      }
    ])
    const laterInstall = vi.fn(async () => verifiedInstallation())
    await expect(
      coordinator.acquire({
        resourceKey: '/workspace',
        configurationKey: cursorWorkspaceConfigurationKey('write'),
        install: laterInstall
      })
    ).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseTaintedError)
    expect(laterInstall).not.toHaveBeenCalled()
  })

  it('freezes cleanup truth shared by an all-aborted batch', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const installed = deferred<{
      onLastRelease: () => { outcome: 'restored-verified' }
    }>()
    const controller = new AbortController()
    const first = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: () => installed.promise
    })
    const second = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      signal: controller.signal,
      install: async () => verifiedInstallation()
    })

    controller.abort()
    installed.resolve({
      onLastRelease: () => ({ outcome: 'restored-verified' })
    })
    const [firstError, secondError] = await Promise.all([
      first.catch((reason: unknown) => reason),
      second.catch((reason: unknown) => reason)
    ])
    const firstCleanup = (firstError as CursorWorkspaceConfigLeaseAbortedError).cleanup
    const secondCleanup = (secondError as CursorWorkspaceConfigLeaseAbortedError).cleanup

    expect(firstCleanup).toBe(secondCleanup)
    expect(Object.isFrozen(firstCleanup)).toBe(true)
    expect(() => {
      Object.assign(firstCleanup!, { outcome: 'cleanup-failed', message: 'forged' })
    }).toThrow()
    expect(secondCleanup).toEqual({ outcome: 'restored-verified' })
  })

  it('awaits install-failure recovery before rejecting or advancing', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const recoveryAllowed = deferred<void>()
    const calls: string[] = []
    const failed = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => {
        calls.push('install-write')
        throw new Error('partial workspace write')
      },
      onInstallFailure: async () => {
        calls.push('rollback-start')
        await recoveryAllowed.promise
        calls.push('rollback-end')
        return { outcome: 'restored-verified' }
      }
    })
    const next = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      install: async () => {
        calls.push('install-plan')
        return verifiedInstallation()
      }
    })

    await vi.waitFor(() => expect(calls).toEqual(['install-write', 'rollback-start']))
    recoveryAllowed.resolve(undefined)
    const error = await failed.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorWorkspaceConfigInstallError)
    expect(error).toMatchObject({
      cleanup: { outcome: 'restored-verified' }
    })
    const nextLease = await next
    expect(calls).toEqual(['install-write', 'rollback-start', 'rollback-end', 'install-plan'])
    await nextLease.release()
  })

  it('reports a missing install-failure recovery receipt instead of inventing rollback', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const error = await coordinator
      .acquire({
        resourceKey: '/workspace',
        configurationKey: cursorWorkspaceConfigurationKey('write'),
        install: async () => {
          throw new Error('setup failed')
        }
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CursorWorkspaceConfigInstallError)
    expect(error).toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('rollback is not proven')
      }
    })
    expect((error as Error).message).toContain('Cleanup could not be proven')
  })

  it('returns one idempotent unverified receipt for a legacy restore helper', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const restore = vi.fn()
    const lease = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => restore
    })

    const [first, second] = await Promise.all([lease.release(), lease.release()])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      finalHolder: true,
      cleanup: {
        outcome: 'restore-attempted-unverified',
        detail: expect.stringContaining('does not expose filesystem restore failures')
      }
    })
    expect(coordinator.snapshot()).toMatchObject([
      {
        cleanupTaint: {
          outcome: 'restore-attempted-unverified'
        }
      }
    ])
  })

  it('snapshots cleanup authority so a mutable installation cannot replace it', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const originalCleanup = vi.fn(() => ({ outcome: 'restored-verified' as const }))
    const replacementCleanup = vi.fn(() => ({ outcome: 'restored-verified' as const }))
    const installation = { onLastRelease: originalCleanup }
    const lease = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => installation
    })

    installation.onLastRelease = replacementCleanup
    await expect(lease.release()).resolves.toMatchObject({
      cleanup: { outcome: 'restored-verified' }
    })
    expect(originalCleanup).toHaveBeenCalledTimes(1)
    expect(replacementCleanup).not.toHaveBeenCalled()
  })

  it('taints before pumping the next overlay when cleanup fails', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => ({
        onLastRelease: () => {
          throw new Error('restore exploded')
        }
      })
    })
    const nextInstall = vi.fn(async () => verifiedInstallation())
    const next = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('read-only'),
      install: nextInstall
    })

    await expect(active.release()).resolves.toMatchObject({
      finalHolder: true,
      cleanup: { outcome: 'cleanup-failed', message: 'restore exploded' }
    })
    await expect(next).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseTaintedError)
    expect(nextInstall).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject([
      {
        activeConfigurationKey: null,
        cleanupTaint: { outcome: 'cleanup-failed', message: 'restore exploded' },
        queuedConfigurationKeys: []
      }
    ])
  })

  it('fails install callback reentrancy fast instead of self-deadlocking', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const failed = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      onInstallFailure: () => ({ outcome: 'restored-verified' }),
      install: async () => {
        await coordinator.acquire({
          resourceKey: '/workspace',
          configurationKey: cursorWorkspaceConfigurationKey('write'),
          install: async () => () => undefined
        })
        return () => undefined
      }
    })

    const error = await failed.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorWorkspaceConfigInstallError)
    expect((error as CursorWorkspaceConfigInstallError).installError).toBeInstanceOf(
      CursorWorkspaceConfigLeaseReentrancyError
    )
  })

  it('turns cleanup callback reentrancy into an honest receipt', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const lease = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => ({
        onLastRelease: async () => {
          await coordinator.acquire({
            resourceKey: '/workspace',
            configurationKey: cursorWorkspaceConfigurationKey('write'),
            install: async () => () => undefined
          })
          return { outcome: 'restored-verified' }
        }
      })
    })

    await expect(lease.release()).resolves.toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('cannot acquire another lease')
      }
    })
  })

  it('makes recursive same-lease release fail fast without splitting receipts', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    // Annotated rather than inferred: `onLastRelease` closes over `lease`, so
    // an un-annotated initializer would be circular ("referenced directly or
    // indirectly in its own initializer"). The annotation breaks that cycle,
    // which is what the old `let lease!` was really for — not reassignment.
    // `const` is safe because the closure is only INVOKED by `release()`, long
    // after this declaration completes, so the TDZ has closed by then. If that
    // ever stopped being true the test would fail rather than pass hollowly:
    // a TDZ ReferenceError surfaces as a cleanup message that does not contain
    // 'cannot acquire another lease', which the assertion below requires.
    const lease: Awaited<ReturnType<typeof coordinator.acquire>> = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => ({
        onLastRelease: async () => {
          await lease.release()
          return { outcome: 'restored-verified' }
        }
      })
    })

    const first = await lease.release()
    const second = await lease.release()
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      finalHolder: true,
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('cannot acquire another lease')
      }
    })
  })

  it('turns install-failure recovery reentrancy into honest cleanup evidence', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const failed = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => {
        throw new Error('partial write')
      },
      onInstallFailure: async () => {
        await coordinator.acquire({
          resourceKey: '/workspace',
          configurationKey: cursorWorkspaceConfigurationKey('read-only'),
          install: async () => () => undefined
        })
        return { outcome: 'restored-verified' }
      }
    })

    const error = await failed.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorWorkspaceConfigInstallError)
    expect(error).toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('cannot acquire another lease')
      }
    })
  })

  it('rejects acquisition reentrancy from an observational queue callback', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    let nested!: Promise<unknown>
    const waiting = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      install: async () => verifiedInstallation(),
      onQueued: () => {
        nested = coordinator.acquire({
          resourceKey: '/workspace',
          configurationKey: cursorWorkspaceConfigurationKey('read-only'),
          install: async () => verifiedInstallation()
        })
      }
    })

    await expect(nested).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseReentrancyError)
    await active.release()
    const lease = await waiting
    await lease.release()
  })

  it('canonicalizes lexical aliases and rejects non-absolute resource identities', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const install = vi.fn(async () => () => undefined)
    const first = await coordinator.acquire({
      resourceKey: '/workspace/./project',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install
    })
    const second = await coordinator.acquire({
      resourceKey: '/workspace/tmp/../project',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install
    })

    expect(first.resourceKey).toBe(canonicalCursorWorkspaceConfigResource('/workspace/project'))
    expect(second.resourceKey).toBe(first.resourceKey)
    expect(install).toHaveBeenCalledTimes(1)
    await first.release()
    await second.release()
    await expect(
      coordinator.acquire({
        resourceKey: 'relative/workspace',
        configurationKey: cursorWorkspaceConfigurationKey('write'),
        install
      })
    ).rejects.toThrow('must be absolute')
  })

  it('rejects NUL-bearing resource and configuration identities', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const install = vi.fn(async () => () => undefined)

    await expect(
      coordinator.acquire({
        resourceKey: '/workspace\u0000/alias',
        configurationKey: cursorWorkspaceConfigurationKey('write'),
        install
      })
    ).rejects.toThrow('must not contain a NUL byte')
    await expect(
      coordinator.acquire({
        resourceKey: '/workspace',
        configurationKey: 'cursor-workspace\u0000config',
        install
      })
    ).rejects.toThrow('must not contain a NUL byte')
    expect(install).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('absorbs an async observational queue callback failure', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const active = await coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => verifiedInstallation()
    })
    const waiting = coordinator.acquire({
      resourceKey: '/workspace',
      configurationKey: cursorWorkspaceConfigurationKey('plan'),
      install: async () => verifiedInstallation(),
      onQueued: async () => {
        await Promise.resolve()
        throw new Error('async renderer failure')
      }
    })

    await active.release()
    const lease = await waiting
    await lease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('does not upgrade invalid or swallowed cleanup to verified restoration', async () => {
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const swallowed = vi.fn()
    const unverified = await coordinator.acquire({
      resourceKey: '/workspace-a',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () =>
        unverifiedCursorWorkspaceConfigRestore(
          swallowed,
          'applyCursorWriteModeConfig suppresses filesystem restore failures.'
        )
    })
    await expect(unverified.release()).resolves.toMatchObject({
      cleanup: {
        outcome: 'restore-attempted-unverified',
        detail: 'applyCursorWriteModeConfig suppresses filesystem restore failures.'
      }
    })

    const invalid = await coordinator.acquire({
      resourceKey: '/workspace-b',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => ({
        onLastRelease: () => ({ outcome: 'probably-restored' }) as never
      })
    })
    await expect(invalid.release()).resolves.toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('unknown outcome')
      }
    })
  })

  it('settles hostile thrown values without escaping the coordinator pump', async () => {
    const hostile = {
      toString(): string {
        throw new Error('stringification exploded')
      }
    }

    const installCoordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const installFailure = installCoordinator.acquire({
      resourceKey: '/workspace-install',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: () => {
        throw hostile
      },
      onInstallFailure: () => ({ outcome: 'restored-verified' })
    })
    const installError = await installFailure.catch((reason: unknown) => reason)
    expect(installError).toBeInstanceOf(CursorWorkspaceConfigInstallError)
    expect((installError as Error).message).toContain('Unprintable thrown value')
    expect(installCoordinator.snapshot()).toEqual([])

    const recoveryCoordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const recoveryFailure = recoveryCoordinator.acquire({
      resourceKey: '/workspace-recovery',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: () => {
        throw new Error('partial write')
      },
      onInstallFailure: () => {
        throw hostile
      }
    })
    await expect(recoveryFailure).rejects.toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: 'Unprintable thrown value.'
      }
    })

    const cleanupCoordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const cleanupLease = await cleanupCoordinator.acquire({
      resourceKey: '/workspace-cleanup',
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => ({
        onLastRelease: () => {
          throw hostile
        }
      })
    })
    await expect(cleanupLease.release()).resolves.toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: 'Unprintable thrown value.'
      }
    })

    const normalizationCoordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const hostileRequest = {
      get resourceKey(): string {
        throw hostile
      },
      configurationKey: cursorWorkspaceConfigurationKey('write'),
      install: async () => () => undefined
    }
    let normalizationFailure!: Promise<unknown>
    expect(() => {
      normalizationFailure = normalizationCoordinator.acquire(hostileRequest)
    }).not.toThrow()
    await expect(normalizationFailure).rejects.toThrow('Unprintable thrown value')
  })
})
