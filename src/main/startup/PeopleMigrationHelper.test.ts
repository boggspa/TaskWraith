import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({
  profile: '',
  spawn: vi.fn(),
  quit: undefined as (() => void) | undefined
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => environment.profile,
    getName: () => 'Helper Test',
    once: (_event: string, callback: () => void) => {
      environment.quit = callback
    },
    removeListener: () => {
      environment.quit = undefined
    }
  }
}))
vi.mock('../devAppName', () => ({ instanceLaunchBootstrapArgs: ['--taskwraith-instance=test'] }))
vi.mock('node:child_process', () => ({ spawn: environment.spawn }))

import { runPeopleMigrationIsolated } from './PeopleMigrationHelper'
import { readPeopleMigrationLease } from './PeopleMigrationHelperLease'
import { createPeopleMigrationDeletionBarrier } from './PeopleMigrationDeletionBarrier'

class Child extends EventEmitter {
  pid: number | undefined = process.pid
  send = vi.fn()
  kill = vi.fn(() => true)
}
let child: Child
beforeEach(() => {
  environment.profile = fs.mkdtempSync(join(tmpdir(), 'taskwraith-migration-owner-'))
  child = new Child()
  environment.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => {
  fs.rmSync(environment.profile, { recursive: true, force: true })
  vi.useRealTimers()
})

async function initialize() {
  const work = runPeopleMigrationIsolated({ runtimeInstanceId: 'test' })
  await vi.waitFor(() => expect(environment.spawn).toHaveBeenCalledOnce())
  expect(child.send).not.toHaveBeenCalled()
  child.emit('spawn')
  child.emit('message', { type: 'ready', pid: child.pid })
  const request = child.send.mock.calls[0][0]
  expect(readPeopleMigrationLease(environment.profile)?.value.childPid).toBe(child.pid)
  child.emit('message', { type: 'armed', nonce: request.nonce })
  return { work, request }
}

describe('isolated People migration ownership', () => {
  it('publishes only after proven exit and carries the exact terminal retention scope', async () => {
    const { work, request } = await initialize()
    expect(child.send.mock.calls[1][0]).toEqual({ type: 'run', nonce: request.nonce })
    let settled = false
    void work.then(() => {
      settled = true
    })
    child.emit('message', {
      type: 'complete',
      nonce: request.nonce,
      result: {
        schemaVersion: 1,
        migration: { phase: 'committed', planId: 'initial' },
        terminalPlanId: 'terminal',
        finalization: { phase: 'committed', retainedWorkspaceBootstrapShareIds: ['retained'] }
      }
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(readPeopleMigrationLease(environment.profile)).not.toBeNull()
    child.emit('exit', 0)
    const result = await work
    expect(result.migration.planId).toBe('initial')
    expect(result.terminalPlanId).toBe('terminal')
    expect(() => result.legacyWriteGate.assertOrdinaryWriteAllowed('retained')).not.toThrow()
    expect(() => result.legacyWriteGate.assertOrdinaryWriteAllowed('ordinary')).toThrow()
    expect(readPeopleMigrationLease(environment.profile)).toBeNull()
  })

  it('kills on deletion before arming and retains the lease until the exit event', async () => {
    const work = runPeopleMigrationIsolated({ runtimeInstanceId: 'test' })
    const rejected = expect(work).rejects.toThrow('History deletion')
    await vi.waitFor(() => expect(environment.spawn).toHaveBeenCalledOnce())
    child.emit('spawn')
    child.emit('message', { type: 'ready', pid: child.pid })
    const request = child.send.mock.calls[0][0]
    fs.writeFileSync(join(environment.profile, 'history-deletion-intent.json'), '{}')
    child.emit('message', { type: 'armed', nonce: request.nonce })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(readPeopleMigrationLease(environment.profile)).not.toBeNull()
    child.emit('exit', null)
    await rejected
    expect(readPeopleMigrationLease(environment.profile)).toBeNull()
  })

  it('refuses out-of-order completion instead of adopting an unstarted migration', async () => {
    const work = runPeopleMigrationIsolated({ runtimeInstanceId: 'test' })
    const rejected = expect(work).rejects.toThrow('did not complete')
    await vi.waitFor(() => expect(environment.spawn).toHaveBeenCalledOnce())
    child.emit('spawn')
    child.emit('message', {
      type: 'complete',
      nonce: readPeopleMigrationLease(environment.profile)!.value.nonce,
      result: {}
    })
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    await rejected
  })

  it('releases an inert starting lease after both synchronous and asynchronous spawn failure', async () => {
    environment.spawn.mockImplementationOnce(() => {
      throw new Error('spawn refused')
    })
    await expect(runPeopleMigrationIsolated({ runtimeInstanceId: 'test' })).rejects.toThrow(
      'spawn refused'
    )
    expect(readPeopleMigrationLease(environment.profile)).toBeNull()
    child.pid = undefined
    const work = runPeopleMigrationIsolated({ runtimeInstanceId: 'test' })
    const rejected = expect(work).rejects.toThrow('spawn failed')
    await vi.waitFor(() => expect(environment.spawn).toHaveBeenCalledTimes(2))
    child.emit('error', new Error('spawn failed'))
    await rejected
    expect(readPeopleMigrationLease(environment.profile)).toBeNull()
  })
})

describe('deletion before People migration', () => {
  it('lets cold purge complete without joining migration and opens capture only after deletion commits', async () => {
    let pending: { operationId: string } | null = { operationId: 'delete' }
    const barrier = createPeopleMigrationDeletionBarrier(() => pending)
    const capture = vi.fn()
    const migration = barrier.ready.then(capture)
    expect(barrier.coldPurge()).toBe(true)
    await Promise.resolve()
    expect(capture).not.toHaveBeenCalled()
    expect(() => barrier.releaseAfterRecovery()).toThrow('not completed')
    pending = null
    barrier.releaseAfterRecovery()
    await migration
    expect(capture).toHaveBeenCalledOnce()
    expect(barrier.coldPurge()).toBe(false)
  })

  it('treats unreadable deletion state as pending, with no timed release', async () => {
    let unreadable = true
    const barrier = createPeopleMigrationDeletionBarrier(() => {
      if (unreadable) throw new Error('unreadable')
      return null
    })
    const capture = vi.fn()
    const migration = barrier.ready.then(capture)
    expect(() => barrier.releaseAfterRecovery()).toThrow('unreadable')
    await Promise.resolve()
    expect(capture).not.toHaveBeenCalled()
    unreadable = false
    barrier.releaseAfterRecovery()
    await migration
    expect(capture).toHaveBeenCalledOnce()
  })
})
