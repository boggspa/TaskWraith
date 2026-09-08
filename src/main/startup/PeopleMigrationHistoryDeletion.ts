import * as fs from 'node:fs'
import { dirname } from 'node:path'
import { peopleToChannelMigrationRecoveryPaths } from '../collaboration/PeopleToChannelMigrationRecoveryStore'
import {
  readPeopleMigrationLease,
  waitForPeopleMigrationIdle,
  type PeopleMigrationDeletionScope
} from './PeopleMigrationHelperLease'
import { withPeopleDonorMutationGate } from '../../host-shared/thread-catalogue/PeopleDonorMutationGate'
import { channelProductionDataPaths } from '../collaboration/ChannelProductionService'
import {
  purgeColdChannelHistoryDeletion,
  type ChannelProductionHistoryDeletionScope
} from '../collaboration/ChannelHistoryDeletionStore'
import type { ChannelAgentIdentitySafeStorage } from '../collaboration/ChannelAgentIdentityStore'

/** Coordinates the existing erasure ordering without starting a serving runtime. */
export function createPeopleMigrationHistoryDeletion(options: {
  profilePath: string
  initialRecovery(): boolean
  ready: Promise<void>
  service():
    | {
        status(): { state: string }
        purgeForHistoryDeletionScope(scope: ChannelProductionHistoryDeletionScope): Promise<unknown>
      }
    | undefined
  pending(): { operationId: string; kind: string } | null
  runMigration(scope: PeopleMigrationDeletionScope): Promise<unknown>
  reload(): void
  safeStorage: ChannelAgentIdentitySafeStorage
}) {
  return async (preparation: {
    operationId: string
    kind: 'global' | 'workspace' | 'chat' | 'truncate'
    chatIds: readonly string[]
  }): Promise<unknown> => {
    const scope =
      preparation.kind === 'global'
        ? { kind: 'global' as const }
        : { kind: preparation.kind, chatIds: [...preparation.chatIds] }
    // Startup migration itself waits on deletion; this branch cannot join it.
    if (!options.initialRecovery()) await options.ready
    await waitForPeopleMigrationIdle(options.profilePath)
    if (scope.kind === 'global') {
      purgePeopleMigrationForGlobalDeletion({
        profilePath: options.profilePath,
        operationId: preparation.operationId,
        pending: options.pending
      })
    }
    const service = options.service()
    if (service?.status().state === 'running') return service.purgeForHistoryDeletionScope(scope)
    if (scope.kind !== 'global') {
      // A later degraded launch can already serve legacy rooms. Retiring its
      // shares here would require a complete runtime handoff, beyond recovery.
      if (!options.initialRecovery())
        throw new Error('Channels history authority is unavailable; history deletion stopped.')
      const deletionScope = { ...scope, operationId: preparation.operationId }
      await withPeopleDonorMutationGate(options.profilePath, async () => {
        try {
          await options.runMigration(deletionScope)
        } finally {
          options.reload()
        }
      })
    }
    options.reload()
    return purgeColdChannelHistoryDeletion({
      paths: channelProductionDataPaths(options.profilePath),
      scope,
      safeStorage: options.safeStorage
    })
  }
}

/** Global erasure includes encrypted copies in migration recovery, not identity keys. */
export function purgePeopleMigrationForGlobalDeletion(options: {
  profilePath: string
  operationId: string
  pending: () => { operationId: string; kind: string } | null
}): void {
  const pending = options.pending()
  if (!pending || pending.kind !== 'global' || pending.operationId !== options.operationId)
    throw new Error('Migration erasure requires the exact pending global deletion')
  if (readPeopleMigrationLease(options.profilePath))
    throw new Error('Migration erasure still has an owner')
  const root = peopleToChannelMigrationRecoveryPaths(options.profilePath).root
  fs.rmSync(root, { recursive: true, force: true })
  let fd: number
  try {
    fd = fs.openSync(dirname(root), 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    fs.fsyncSync(fd)
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
  } finally {
    fs.closeSync(fd)
  }
}
