/**
 * The usage log through the real store: with barrier durability a recorded
 * usage row syncs nothing on the calling thread and is paid through the
 * layer's port at its background class, and quit pays what is left. With the
 * switch off, every row syncs where it is written, as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadDurabilityPort, ThreadDurabilitySyncOptions } from './ThreadDurabilityDebt'
import type { UsageRecord } from './types'
import { disposeHostOwnedStores, importHostOwnedStore } from './hostOwnedErasure.testutil'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

const layers = vi.hoisted(() => ({ port: null as ThreadDurabilityPort | null }))

vi.mock('./ThreadBarrierDurability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ThreadBarrierDurability')>()
  return {
    ...actual,
    createThreadBarrierDurability: (
      options: import('./ThreadBarrierDurability').ThreadBarrierDurabilityOptions = {}
    ) =>
      actual.createThreadBarrierDurability({
        ...options,
        port: {
          syncFile: (target, sync) => layers.port!.syncFile(target, sync),
          syncDirectory: (target, sync) => layers.port!.syncDirectory(target, sync)
        }
      })
  }
})

const disks: CrashDisk[] = []

afterEach(async () => {
  while (disks.length > 0) disks.pop()!.dispose()
  layers.port = null
  vi.unstubAllEnvs()
  await disposeHostOwnedStores()
})

function usage(runId: string): Omit<UsageRecord, 'id' | 'timestamp'> {
  return {
    workspaceId: 'workspace',
    chatId: 'chat',
    runId,
    usageKind: 'run',
    model: 'model',
    provider: 'codex',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 10
  } as Omit<UsageRecord, 'id' | 'timestamp'>
}

/** The disk's port, listing each sync it pays with its class. */
function listing(disk: CrashDisk, paid: string[]): ThreadDurabilityPort {
  const note = (kind: string, target: string, sync?: ThreadDurabilitySyncOptions): void => {
    const name = target.split('/').pop()
    paid.push(
      `${kind}:${name}:${sync?.urgent ? 'urgent' : sync?.background ? 'background' : 'normal'}`
    )
  }
  return {
    syncFile: (target, sync) => {
      note('file', target, sync)
      return disk.port.syncFile(target, sync)
    },
    syncDirectory: (target, sync) => {
      note('directory', target, sync)
      return disk.port.syncDirectory(target, sync)
    }
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

const usageSyncs = (issued: string[]): string[] => issued.filter((entry) => entry.includes('usage'))

describe('the usage log through the store', () => {
  it('under barrier durability, syncs no usage row on the calling thread, pays it in the background and at quit', async () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const paid: string[] = []
    layers.port = listing(disk, paid)

    for (let index = 0; index < 3; index += 1) AppStore.recordUsage(usage(`run-${index}`))
    await settle()

    expect(usageSyncs(disk.issued)).toEqual([])
    expect(paid.filter((entry) => entry.includes('usage'))).toEqual([
      'file:usage-journal.jsonl:background'
    ])
    expect(AppStore.getUsage().map((record) => record.runId)).toEqual(['run-0', 'run-1', 'run-2'])

    AppStore.recordUsage(usage('run-3'))
    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 1_000 })
    expect(usageSyncs(disk.issued)).toEqual([])
    expect(paid.filter((entry) => entry.includes('usage'))).toEqual([
      'file:usage-journal.jsonl:background',
      'file:usage-journal.jsonl:normal'
    ])
    expect(AppStore.getThreadBarrierDurabilityPerf().usageLog).toMatchObject({
      appends: 4,
      spills: 0,
      background: { quitRounds: 1, quitUnpaid: 0 }
    })
  })

  it('with the switch off, syncs every usage row where it is written, and reports no usage log counters', async () => {
    // On by default: off needs the exact token `0`. Absent, the store would
    // build the barrier layer at import, over a port this case never sets.
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)

    AppStore.recordUsage(usage('run-0'))

    expect(usageSyncs(disk.issued)).toEqual(['file:usage-journal.jsonl'])
    expect(AppStore.getThreadBarrierDurabilityPerf().usageLog).toBeNull()
  })
})
