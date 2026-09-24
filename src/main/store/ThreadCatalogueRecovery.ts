import { chatRunIsReconcilable } from '../ChatRunReconciler'
import { nextBlackboardExpiryAt } from '../blackboard/Blackboard'
import { bindSubThreadJoinPolicyToRun } from '../SubThreadJoinPolicy'
import type { ChatRecord, SubThreadJoinPolicy } from './types'

export interface ThreadCatalogueRecoveryRecord {
  id: string
  kind: 'run' | 'ensemble-wakeup' | 'solo-wakeup' | 'worker-event' | 'join' | 'blackboard-expiry'
  value: Record<string, unknown>
}

/** Operational records only; no transcript is needed to discover or inspect recovery work. */
export function collectThreadCatalogueRecovery(chat: ChatRecord): ThreadCatalogueRecoveryRecord[] {
  const records: ThreadCatalogueRecoveryRecord[] = []
  for (const run of chat.runs ?? []) {
    if (!run?.runId || !chatRunIsReconcilable(run)) continue
    records.push({
      id: `run:${run.runId}`,
      kind: 'run',
      value: {
        kind: 'run',
        chatId: chat.appChatId,
        runId: run.runId,
        provider: run.provider ?? chat.provider,
        ...(run.hostRunOrigin ? { hostRunOrigin: run.hostRunOrigin } : {}),
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt
      }
    })
  }
  for (const [kind, source] of [
    ['ensemble-wakeup', chat.ensemble?.wakeups],
    ['solo-wakeup', chat.soloWakeups]
  ] as const) {
    for (const wakeup of Object.values(source ?? {})) {
      if (wakeup.status !== 'pending') continue
      records.push({
        id: `${kind}:${wakeup.wakeupId}`,
        kind,
        value: { kind, chatId: chat.appChatId, record: wakeup }
      })
    }
  }
  const events = chat.delegationContext?.workerControl?.events ?? []
  for (const event of events) {
    if (!['pending', 'claimed', 'dispatched'].includes(event.status)) continue
    records.push({
      id: `worker-event:${event.id}`,
      kind: 'worker-event',
      value: {
        kind: 'worker-event',
        chatId: chat.appChatId,
        parentChatId: chat.parentChatId,
        record: event
      }
    })
  }
  const groups = new Map<string, Array<Record<string, unknown>>>()
  const addPolicy = (policy: SubThreadJoinPolicy, worker: Record<string, unknown>): void => {
    const group = groups.get(policy.groupId) ?? []
    group.push(worker)
    groups.set(policy.groupId, group)
  }
  const direct = chat.delegationContext?.joinPolicy
  if (direct)
    addPolicy(direct, {
      subThreadId: chat.appChatId,
      workerRunId: direct.workerRunId,
      policy: direct,
      resultReturnedAt: chat.delegationContext?.resultReturnedAt
    })
  for (const event of events) {
    if (!event.joinPolicy) continue
    const outcome =
      event.status === 'completed'
        ? 'done'
        : event.status === 'failed'
          ? 'failed'
          : event.status === 'cancelled'
            ? 'cancelled'
            : undefined
    addPolicy(event.joinPolicy, {
      subThreadId: chat.appChatId,
      workerRunId: event.plannedRunId,
      policy: event.joinPolicy.workerRunId
        ? event.joinPolicy
        : bindSubThreadJoinPolicyToRun(event.joinPolicy, event.plannedRunId),
      ...(outcome
        ? { terminal: { at: event.terminalAt || event.processedAt || event.enqueuedAt, outcome } }
        : {})
    })
  }
  for (const [groupId, workers] of groups)
    records.push({
      id: `join:${groupId}`,
      kind: 'join',
      value: {
        kind: 'join',
        chatId: chat.appChatId,
        parentChatId: chat.parentChatId,
        groupId,
        workers
      }
    })
  const expiry = nextBlackboardExpiryAt(chat.ensemble?.blackboard ?? [])
  if (expiry !== null)
    records.push({
      id: 'blackboard-expiry',
      kind: 'blackboard-expiry',
      value: { kind: 'blackboard-expiry', chatId: chat.appChatId, nextExpiryAt: expiry }
    })
  return records
}
