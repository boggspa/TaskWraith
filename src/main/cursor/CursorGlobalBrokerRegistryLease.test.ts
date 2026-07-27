import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalCursorGlobalBrokerRegistryResource,
  CursorGlobalBrokerRegistryLeaseAbortedError,
  CursorGlobalBrokerRegistryLeaseCoordinator,
  CursorGlobalBrokerRegistryInstallError,
  CursorGlobalBrokerRegistryReentrancyError,
  CursorGlobalBrokerRegistryTaintedError,
  cursorGlobalBrokerRegistrationKey,
  normalizeCursorGlobalBrokerRegistrationDescriptor,
  retainedCursorGlobalBrokerRegistration,
  unverifiedCursorGlobalBrokerRestore
} from './CursorGlobalBrokerRegistryLease'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The lease resolves its registry path, so a literal POSIX string never
// matches on Windows — it comes back as `D:\Users\person\.cursor\mcp.json`.
const REGISTRY = resolve('/Users/person/.cursor/mcp.json')

function verifiedInstallFailureContract() {
  return {
    onInstallFailure: () => ({ outcome: 'restored-verified' as const })
  }
}

function descriptor(profile: 'full' | 'plan' | 'read-only', token = 'socket-1') {
  return {
    brokerEntries: {
      'taskwraith-broker': {
        command: '/Applications/TaskWraith',
        args: ['/bridge.cjs', `--${profile}`, '--socket', token],
        env: { TASKWRAITH_PARENT_PROVIDER: 'cursor', ELECTRON_RUN_AS_NODE: '1' }
      }
    },
    removeServerNames: ['taskwraith-cursor'],
    ...verifiedInstallFailureContract()
  }
}

describe('CursorGlobalBrokerRegistryLeaseCoordinator', () => {
  it('canonicalizes lexical aliases to one global registry resource', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const first = await coordinator.acquire({
      registryPath: '/Users/person/.cursor/./mcp.json',
      ...descriptor('full'),
      install
    })
    const second = await coordinator.acquire({
      registryPath: '/Users/person/tmp/../.cursor/mcp.json',
      ...descriptor('full'),
      install
    })

    expect(first.resourceKey).toBe(canonicalCursorGlobalBrokerRegistryResource(REGISTRY))
    expect(second.resourceKey).toBe(first.resourceKey)
    expect(install).toHaveBeenCalledTimes(1)
    await first.release()
    await second.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('prefers the caller-resolved physical resource identity over path aliases', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const first = await coordinator.acquire({
      registryPath: '/private/alias-home/.cursor/mcp.json',
      canonicalRegistryResourcePath: REGISTRY,
      ...descriptor('full'),
      install
    })
    const second = await coordinator.acquire({
      registryPath: '/Volumes/home-link/.cursor/mcp.json',
      canonicalRegistryResourcePath: REGISTRY,
      ...descriptor('full'),
      install
    })

    expect(first.resourceKey).toBe(REGISTRY)
    expect(second.resourceKey).toBe(REGISTRY)
    expect(install).toHaveBeenCalledTimes(1)
    await first.release()
    await second.release()
  })

  it('shares semantically identical descriptors regardless of object or removal order', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const first = await coordinator.acquire({
      registryPath: REGISTRY,
      brokerEntries: {
        beta: { args: ['b'], command: 'node' },
        alpha: { env: { B: '2', A: '1' }, command: 'node', args: ['a'] }
      },
      removeServerNames: ['old-b', 'old-a'],
      ...verifiedInstallFailureContract(),
      install
    })
    const second = await coordinator.acquire({
      registryPath: REGISTRY,
      brokerEntries: {
        alpha: { args: ['a'], command: 'node', env: { A: '1', B: '2' } },
        beta: { command: 'node', args: ['b'] }
      },
      removeServerNames: ['old-a', 'old-b', 'old-a'],
      ...verifiedInstallFailureContract(),
      install
    })

    expect(first.registrationKey).toBe(second.registrationKey)
    expect(install).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject([{ activeHolders: 2 }])
    await first.release()
    const last = await second.release()
    expect(last).toMatchObject({
      finalHolder: true,
      cleanup: { outcome: 'retained-persistent' }
    })
  })

  it('serializes incompatible profiles FIFO and awaits cleanup before the next install', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const cleanupAllowed = deferred<void>()
    const calls: string[] = []
    const full = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => {
        calls.push('install-full')
        return {
          onLastRelease: async () => {
            calls.push('cleanup-full-start')
            await cleanupAllowed.promise
            calls.push('cleanup-full-end')
            return { outcome: 'restored-verified' }
          }
        }
      }
    })
    const planPromise = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('plan'),
      install: async () => {
        calls.push('install-plan')
        return retainedCursorGlobalBrokerRegistration()
      }
    })
    const readPromise = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('read-only'),
      install: async () => {
        calls.push('install-read')
        return retainedCursorGlobalBrokerRegistration()
      }
    })

    const releasing = full.release()
    await Promise.resolve()
    expect(calls).toEqual(['install-full', 'cleanup-full-start'])
    cleanupAllowed.resolve(undefined)
    await releasing
    const plan = await planPromise
    expect(calls).toEqual([
      'install-full',
      'cleanup-full-start',
      'cleanup-full-end',
      'install-plan'
    ])
    await plan.release()
    const read = await readPromise
    expect(calls.at(-1)).toBe('install-read')
    await read.release()
  })

  it('does not let compatible arrivals starve an incompatible waiter', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const calls: string[] = []
    const full = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    const planPromise = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('plan'),
      install: async () => {
        calls.push('install-plan')
        return retainedCursorGlobalBrokerRegistration()
      }
    })
    const laterFullPromise = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => {
        calls.push('install-full-later')
        return retainedCursorGlobalBrokerRegistration()
      }
    })

    await full.release()
    const plan = await planPromise
    expect(calls).toEqual(['install-plan'])
    await plan.release()
    const laterFull = await laterFullPromise
    expect(calls).toEqual(['install-plan', 'install-full-later'])
    await laterFull.release()
  })

  it('admits compatible waiters when the incompatible queue head aborts', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const fullInstall = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const full = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: fullInstall
    })
    const controller = new AbortController()
    const plan = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('plan'),
      signal: controller.signal,
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    const compatible = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: fullInstall
    })

    controller.abort()
    await expect(plan).rejects.toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    const joined = await compatible
    expect(fullInstall).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject([{ activeHolders: 2 }])
    await full.release()
    await joined.release()
  })

  it('removes an aborted queued profile without disturbing the active lease', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const active = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    const controller = new AbortController()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const waiting = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('read-only'),
      install,
      signal: controller.signal
    })
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    expect(install).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject([{ activeHolders: 1, queuedRegistrationKeys: [] }])
    await active.release()
  })

  it('does not install a request whose signal was already aborted', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const controller = new AbortController()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    controller.abort()

    await expect(
      coordinator.acquire({
        registryPath: REGISTRY,
        ...descriptor('full'),
        install,
        signal: controller.signal
      })
    ).rejects.toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    expect(install).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('lets a queue callback abort its own request without leaving stale work', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const active = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    const controller = new AbortController()
    const install = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const waiting = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('plan'),
      install,
      signal: controller.signal,
      onQueued: () => controller.abort()
    })

    await expect(waiting).rejects.toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    await active.release()
    expect(install).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('cleans up an installation whose entire in-flight batch aborts before admission', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const installed = deferred<ReturnType<typeof unverifiedCursorGlobalBrokerRestore>>()
    const restore = vi.fn()
    const controller = new AbortController()
    let rejected = false
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      signal: controller.signal,
      install: () => installed.promise
    })
    void first.catch(() => {
      rejected = true
    })
    controller.abort()
    await Promise.resolve()
    expect(rejected).toBe(false)

    installed.resolve(unverifiedCursorGlobalBrokerRestore(restore))
    const error = await first.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    expect(error).toMatchObject({
      cleanup: { outcome: 'restore-attempted-unverified' }
    })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject([
      {
        queuedRegistrationKeys: [],
        taint: {
          phase: 'aborted-install-cleanup',
          cleanup: { outcome: 'restore-attempted-unverified' }
        }
      }
    ])
  })

  it('carries an all-aborted cleanup failure instead of orphaning it', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const installed = deferred<{
      onLastRelease: () => never
    }>()
    const controller = new AbortController()
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      signal: controller.signal,
      install: () => installed.promise
    })
    controller.abort()
    installed.resolve({
      onLastRelease: () => {
        throw new Error('restore failed after cancellation')
      }
    })

    const error = await first.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorGlobalBrokerRegistryLeaseAbortedError)
    expect(error).toMatchObject({
      cleanup: {
        outcome: 'cleanup-failed',
        message: 'restore failed after cancellation'
      }
    })
  })

  it('rejects a failed compatible batch and advances the next profile', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const setup = deferred<ReturnType<typeof retainedCursorGlobalBrokerRegistration>>()
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: () => setup.promise
    })
    const compatible = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    const next = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('plan'),
      install: async () => retainedCursorGlobalBrokerRegistration()
    })
    setup.reject(new Error('registry write failed'))

    await expect(first).rejects.toThrow('registry write failed')
    await expect(compatible).rejects.toThrow('registry write failed')
    const nextLease = await next
    await nextLease.release()
    expect(coordinator.snapshot()).toEqual([])
  })

  it('awaits uncertain install-failure recovery and taints before rejecting the next profile', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const recoveryAllowed = deferred<void>()
    const calls: string[] = []
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => {
        calls.push('install-full')
        throw new Error('partial write')
      },
      onInstallFailure: async () => {
        calls.push('rollback-start')
        await recoveryAllowed.promise
        calls.push('rollback-end')
        return { outcome: 'restore-attempted-unverified' }
      }
    })
    const nextError = coordinator
      .acquire({
        registryPath: REGISTRY,
        ...descriptor('plan'),
        install: async () => {
          calls.push('install-plan')
          return retainedCursorGlobalBrokerRegistration()
        }
      })
      .catch((reason: unknown) => reason)

    await vi.waitFor(() => expect(calls).toEqual(['install-full', 'rollback-start']))
    recoveryAllowed.resolve(undefined)
    const error = await first.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorGlobalBrokerRegistryInstallError)
    expect(error).toMatchObject({
      cleanup: { outcome: 'restore-attempted-unverified' }
    })
    expect(await nextError).toBeInstanceOf(CursorGlobalBrokerRegistryTaintedError)
    expect(calls).toEqual(['install-full', 'rollback-start', 'rollback-end'])
    expect(coordinator.snapshot()).toMatchObject([
      {
        taint: {
          phase: 'install-failure',
          cleanup: { outcome: 'restore-attempted-unverified' }
        }
      }
    ])
  })

  it('does not join a same-profile arrival to a batch already in failure recovery', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const recoveryStarted = deferred<void>()
    const recoveryAllowed = deferred<void>()
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => {
        throw new Error('first install failed')
      },
      onInstallFailure: async () => {
        recoveryStarted.resolve(undefined)
        await recoveryAllowed.promise
        return { outcome: 'restored-verified' }
      }
    })
    await recoveryStarted.promise
    const secondInstall = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const second = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: secondInstall
    })

    recoveryAllowed.resolve(undefined)
    await expect(first).rejects.toBeInstanceOf(CursorGlobalBrokerRegistryInstallError)
    const secondLease = await second
    expect(secondInstall).toHaveBeenCalledTimes(1)
    await secondLease.release()
  })

  it('fails install-callback reentrancy fast instead of self-deadlocking', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const first = coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => {
        await coordinator.acquire({
          registryPath: REGISTRY,
          ...descriptor('full'),
          install: async () => retainedCursorGlobalBrokerRegistration()
        })
        return retainedCursorGlobalBrokerRegistration()
      }
    })

    const error = await first.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CursorGlobalBrokerRegistryInstallError)
    expect((error as CursorGlobalBrokerRegistryInstallError).installError).toBeInstanceOf(
      CursorGlobalBrokerRegistryReentrancyError
    )
  })

  it('turns cleanup-callback reentrancy into a receipt instead of deadlocking', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const lease = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => ({
        onLastRelease: async () => {
          await coordinator.acquire({
            registryPath: REGISTRY,
            ...descriptor('full'),
            install: async () => retainedCursorGlobalBrokerRegistration()
          })
          return { outcome: 'retained-persistent' }
        }
      })
    })

    await expect(lease.release()).resolves.toMatchObject({
      finalHolder: true,
      cleanup: {
        outcome: 'cleanup-failed',
        message: expect.stringContaining('cannot acquire another lease')
      }
    })
  })

  it('reports swallowed-restore helpers as unverified and never upgrades the claim', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const swallowedRestore = vi.fn(() => {
      // This models applyCursorWriteModeConfig.restore(): it returns normally
      // even when an internal filesystem operation was caught.
    })
    const lease = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () =>
        unverifiedCursorGlobalBrokerRestore(
          swallowedRestore,
          'Workspace config restore is best-effort and suppresses fs errors.'
        )
    })

    const receipt = await lease.release()
    expect(receipt.cleanup).toEqual({
      outcome: 'restore-attempted-unverified',
      detail: 'Workspace config restore is best-effort and suppresses fs errors.'
    })
  })

  it('turns cleanup exceptions into an honest receipt and taints queued/future profiles', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const active = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => ({
        onLastRelease: () => {
          throw new Error('restore exploded')
        }
      })
    })
    const nextInstall = vi.fn(async () => retainedCursorGlobalBrokerRegistration())
    const nextError = coordinator
      .acquire({
        registryPath: REGISTRY,
        ...descriptor('read-only'),
        install: nextInstall
      })
      .catch((reason: unknown) => reason)

    const release = await active.release()
    expect(release).toMatchObject({
      finalHolder: true,
      cleanup: { outcome: 'cleanup-failed', message: 'restore exploded' }
    })
    expect(Reflect.set(release.cleanup!, 'outcome', 'restored-verified')).toBe(false)
    expect(await nextError).toMatchObject({
      name: 'CursorGlobalBrokerRegistryTaintedError',
      phase: 'last-release',
      cleanup: { outcome: 'cleanup-failed', message: 'restore exploded' }
    })
    const taintSnapshot = coordinator.snapshot()[0].taint!
    expect(Reflect.set(taintSnapshot, 'phase', 'install-failure')).toBe(false)
    expect(Reflect.set(taintSnapshot.cleanup, 'outcome', 'restored-verified')).toBe(false)
    const futureError = await coordinator
      .acquire({
        registryPath: REGISTRY,
        ...descriptor('plan'),
        install: nextInstall
      })
      .catch((reason: unknown) => reason)
    expect(futureError).toBeInstanceOf(CursorGlobalBrokerRegistryTaintedError)
    expect(futureError).toMatchObject({
      phase: 'last-release',
      cleanup: { outcome: 'cleanup-failed', message: 'restore exploded' }
    })
    expect(nextInstall).not.toHaveBeenCalled()
    expect(coordinator.snapshot()).toMatchObject([
      {
        queuedRegistrationKeys: [],
        taint: {
          phase: 'last-release',
          cleanup: { outcome: 'cleanup-failed', message: 'restore exploded' }
        }
      }
    ])
  })

  it('does not accept an unknown cleanup outcome as restoration evidence', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const lease = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => ({
        onLastRelease: () => ({ outcome: 'probably-restored' }) as never
      })
    })

    await expect(lease.release()).resolves.toMatchObject({
      finalHolder: true,
      cleanup: {
        outcome: 'cleanup-failed',
        message: 'Cursor global broker cleanup returned an unknown receipt outcome.'
      }
    })
  })

  it('makes release idempotent, including the exact cleanup receipt', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const cleanup = vi.fn(() => ({ outcome: 'restored-verified' as const }))
    const lease = await coordinator.acquire({
      registryPath: REGISTRY,
      ...descriptor('full'),
      install: async () => ({ onLastRelease: cleanup })
    })

    const [first, second] = await Promise.all([lease.release(), lease.release()])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('rejects non-JSON descriptors instead of treating them as compatible', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    await expect(
      coordinator.acquire({
        registryPath: REGISTRY,
        brokerEntries: { 'taskwraith-broker': { command: new Date() } },
        ...verifiedInstallFailureContract(),
        install: async () => retainedCursorGlobalBrokerRegistration()
      })
    ).rejects.toThrow('plain JSON objects')
    await expect(
      coordinator.acquire({
        registryPath: REGISTRY,
        brokerEntries: { 'taskwraith-broker': { timeout: Number.NaN } },
        ...verifiedInstallFailureContract(),
        install: async () => retainedCursorGlobalBrokerRegistration()
      })
    ).rejects.toThrow('finite JSON numbers')
  })

  it('preserves __proto__ as exact JSON data so it cannot collide with another profile', () => {
    const withRootProto = JSON.parse(
      '{"brokerEntries":{"__proto__":{"command":"node","args":["root"]}}}'
    )
    const withNestedProto = JSON.parse(
      '{"brokerEntries":{"taskwraith-broker":{"command":"node","__proto__":{"scope":"safe"}}}}'
    )
    const withoutProto = { brokerEntries: {} }

    const root = normalizeCursorGlobalBrokerRegistrationDescriptor(withRootProto)
    const nested = normalizeCursorGlobalBrokerRegistrationDescriptor(withNestedProto)
    expect(Object.getPrototypeOf(root.brokerEntries)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(root.brokerEntries, '__proto__')).toBe(true)
    expect(
      Object.prototype.hasOwnProperty.call(nested.brokerEntries['taskwraith-broker'], '__proto__')
    ).toBe(true)
    expect(cursorGlobalBrokerRegistrationKey(withRootProto)).not.toBe(
      cursorGlobalBrokerRegistrationKey(withoutProto)
    )
    expect(cursorGlobalBrokerRegistrationKey(withNestedProto)).not.toBe(
      cursorGlobalBrokerRegistrationKey({
        brokerEntries: {
          'taskwraith-broker': { command: 'node' }
        }
      })
    )
  })

  it('rejects relative registry paths instead of binding them to process cwd', async () => {
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    await expect(
      coordinator.acquire({
        registryPath: '.cursor/mcp.json',
        ...descriptor('full'),
        install: async () => retainedCursorGlobalBrokerRegistration()
      })
    ).rejects.toThrow('must be absolute')
  })

  it('passes an immutable normalized descriptor to the single batch installer', async () => {
    const raw = {
      brokerEntries: {
        z: { env: { Z: '1', A: '2' }, args: ['x'], command: 'node' }
      },
      removeServerNames: ['z-old', 'a-old']
    }
    const normalized = normalizeCursorGlobalBrokerRegistrationDescriptor(raw)
    const expectedKey = cursorGlobalBrokerRegistrationKey(raw)
    const install = vi.fn(async (context) => {
      expect(context.registrationKey).toBe(expectedKey)
      expect(context.descriptor).toEqual(normalized)
      expect(Object.isFrozen(context.descriptor)).toBe(true)
      expect(Object.isFrozen(context.descriptor.brokerEntries.z)).toBe(true)
      return retainedCursorGlobalBrokerRegistration()
    })
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()
    const lease = await coordinator.acquire({
      registryPath: REGISTRY,
      ...raw,
      ...verifiedInstallFailureContract(),
      install
    })
    await lease.release()
    expect(install).toHaveBeenCalledTimes(1)
  })
})
