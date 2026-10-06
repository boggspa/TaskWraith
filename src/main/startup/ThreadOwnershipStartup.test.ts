import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HostOwnershipReceiptEvidenceStore,
  createFileReceiptEvidencePersistence
} from '../host/HostOwnershipReceiptEvidenceStore'
import { startThreadOwnershipConsumers } from './ThreadOwnershipStartup'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('ownership startup evidence barrier', () => {
  it('does not admit consumers or register the desktop while hydration is pending', async () => {
    let resolve!: () => void
    const hydrated = new Promise<void>((done) => {
      resolve = done
    })
    const order: string[] = []
    const ready = startThreadOwnershipConsumers({
      hydrate: () => hydrated,
      install: () => {
        order.push('install')
      },
      registerOwner: async () => {
        order.push('owner')
      },
      start: () => {
        order.push('start')
      }
    })
    await Promise.resolve()
    expect(order).toEqual([])
    resolve()
    await ready
    expect(order).toEqual(['install', 'owner', 'start'])
  })

  it('hydrates durable exact handles after a restart before consumers read them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ownership-startup-'))
    directories.push(directory)
    const persistence = createFileReceiptEvidencePersistence(join(directory, 'receipts.json'))
    const evidence = {
      kind: 'exact' as const,
      threadId: 'chat',
      commandId: 'submitted-command',
      revision: 7,
      sha256: 'a'.repeat(64)
    }
    await new HostOwnershipReceiptEvidenceStore(persistence).record(evidence)
    const restarted = new HostOwnershipReceiptEvidenceStore(persistence)
    let installed = false
    await startThreadOwnershipConsumers({
      hydrate: () => restarted.load(),
      install: () => {
        expect(restarted.getLoaded('submitted-command')).toEqual(evidence)
        installed = true
      },
      registerOwner: async () => {
        expect(installed).toBe(true)
      },
      start: () => {
        expect(installed).toBe(true)
      }
    })
    await restarted.forgetChat('chat')
    const afterErasure = new HostOwnershipReceiptEvidenceStore(persistence)
    await afterErasure.load()
    expect(afterErasure.getLoaded('submitted-command')).toBeNull()
  })

  it('retains an unreadable evidence file and rejects dependent startup', async () => {
    const write = vi.fn()
    const store = new HostOwnershipReceiptEvidenceStore({
      read: async () => {
        throw new Error('read denied')
      },
      write
    })
    const install = vi.fn()
    const registerOwner = vi.fn(async () => undefined)
    const start = vi.fn()
    await expect(
      startThreadOwnershipConsumers({
        hydrate: () => store.load(),
        install,
        registerOwner,
        start
      })
    ).rejects.toThrow('read denied')
    expect(install).not.toHaveBeenCalled()
    expect(registerOwner).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
