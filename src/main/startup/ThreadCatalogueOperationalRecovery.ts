import { classifyWakeupRecovery } from '../WakeupTimerService'
import type { EnsembleWakeupRecord, SoloChatWakeupRecord } from '../store/types'
import type { ThreadCatalogueProjection } from '../store/ThreadCatalogue'
import type { ThreadCatalogueRecovery } from './ThreadCatalogueRecovery'
import type { ThreadCatalogueReadPort } from '../store/ThreadCatalogueMirror'

export function createCatalogueOperationalRecovery(deps: {
  recovery: () => ThreadCatalogueRecovery
  launchAt: number
  wakeupsEnabled(): boolean
  arm(wakeup: EnsembleWakeupRecord | SoloChatWakeupRecord): void
  observeExpiry(chatId: string, expiry: number | null): void
  drainWorker(chatId: string): Promise<void>
  scheduleJoin(parentChatId: string, groupId: string): void
}): (
  projection: ThreadCatalogueProjection,
  records: readonly Record<string, unknown>[]
) => Promise<void> {
  return async (projection, records) => {
    const chatId = projection.summary.chatId
    deps.observeExpiry(chatId, projection.recovery.nextBlackboardExpiryAt)
    for (const record of records) {
      if (
        (record.kind === 'ensemble-wakeup' || record.kind === 'solo-wakeup') &&
        deps.wakeupsEnabled()
      ) {
        const wakeup = record.record as EnsembleWakeupRecord | SoloChatWakeupRecord
        // Migration latency cannot itself turn an eligible wakeup into an
        // expired one. Dispatch still validates permissions against real time.
        const actions = classifyWakeupRecovery([wakeup], {
          nowMs: deps.launchAt,
          nowIso: new Date(deps.launchAt).toISOString()
        })
        for (const action of actions) {
          if (action.action === 'arm' || action.action === 'fire') deps.arm(action.wakeup)
          else
            await deps.recovery().mutate(chatId, {
              kind: 'expire-wakeup',
              family: record.kind === 'solo-wakeup' ? 'solo' : 'ensemble',
              wakeupId: wakeup.wakeupId,
              expectedWakeAt: wakeup.wakeAt,
              expiredAt: action.expiredAt
            })
        }
      }
      if (
        record.kind === 'join' &&
        typeof record.parentChatId === 'string' &&
        typeof record.groupId === 'string'
      )
        deps.scheduleJoin(record.parentChatId, record.groupId)
    }
    if (records.some((record) => record.kind === 'worker-event')) {
      await deps
        .recovery()
        .mutate(chatId, { kind: 'recover-worker-control', at: new Date().toISOString() })
      await deps.drainWorker(chatId)
    }
  }
}

export function createCatalogueBlackboardPruner(
  port: ThreadCatalogueReadPort,
  recovery: () => ThreadCatalogueRecovery | null
) {
  return async (chatId: string, atMs: number): Promise<number | null> => {
    const coordinator = recovery()
    if (!coordinator) throw new Error('History recovery is starting')
    const changed = await coordinator.mutate(chatId, { kind: 'prune-blackboard', atMs })
    const current = changed
      ? { projection: changed }
      : await port.query<{ projection: ThreadCatalogueProjection } | null>({
          method: 'summary',
          chatId
        })
    if (!current) throw new Error('History expiry metadata is unavailable')
    const next = current.projection.recovery.nextBlackboardExpiryAt
    if (next !== null && next <= atMs)
      throw new Error('History expiry deferred while this chat is active')
    return next
  }
}
