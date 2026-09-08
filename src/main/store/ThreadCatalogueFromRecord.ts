import { deriveRemoteTaskStatusForChat } from '../RemoteTaskProjection'
import { isThreadTitleRepairTarget, deriveThreadTitleFromTranscript } from './ThreadTitleRepair'
import { chatRunIsReconcilable } from '../ChatRunReconciler'
import { nextBlackboardExpiryAt } from '../blackboard/Blackboard'
import { projectThreadCatalogueChrome, copyThreadCatalogueLastRun } from './ThreadCatalogueChrome'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import type { ChatRecord } from './types'

/** Only persisted fields determine durable metadata; clocks and default rosters do not. */
export function projectThreadCatalogueRecord(chat: ChatRecord): ThreadCatalogueProjection {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  const last = runs.at(-1)
  let presentationRun: typeof last
  for (const run of runs) {
    if (!run) continue
    if (
      !presentationRun ||
      (Date.parse(run.startedAt || '') || 0) > (Date.parse(presentationRun.startedAt || '') || 0)
    )
      presentationRun = run
  }
  const presentation = {
    status: deriveRemoteTaskStatusForChat({
      ...chat,
      runs: presentationRun ? [presentationRun] : []
    }),
    ...(presentationRun?.runId ? { runId: presentationRun.runId } : {}),
    ...(presentationRun?.startedAt ? { startedAt: presentationRun.startedAt } : {}),
    runningRunCount: runs.filter((run) => run?.status === 'running').length
  }
  const events = chat.delegationContext?.workerControl?.events ?? []
  const joinPolicies = new Set<string>()
  if (chat.delegationContext?.joinPolicy)
    joinPolicies.add(chat.delegationContext.joinPolicy.groupId)
  for (const event of events) if (event.joinPolicy) joinPolicies.add(event.joinPolicy.groupId)
  const chrome = projectThreadCatalogueChrome(chat)
  if (isThreadTitleRepairTarget(chat))
    chrome.derivedThreadTitle = deriveThreadTitleFromTranscript(chat) ?? undefined
  return {
    revision:
      Number.isSafeInteger(chat.persistenceRevision) && (chat.persistenceRevision ?? -1) >= 0
        ? chat.persistenceRevision!
        : 0,
    summary: {
      chatId: chat.appChatId,
      title: String(chat.title ?? '').slice(0, 2048),
      provider: String(chat.provider ?? '').slice(0, 128),
      chatKind: chat.chatKind === 'ensemble' ? 'ensemble' : 'single',
      scope: chat.scope === 'global' ? 'global' : 'workspace',
      ...(chat.scope !== 'global' && chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
      ...(chat.scope !== 'global' && chat.workspacePath
        ? { workspacePath: chat.workspacePath }
        : {}),
      ...(chat.parentChatId
        ? {
            parentChatId: chat.parentChatId,
            parentChatRelation: chat.parentChatRelation === 'sideChat' ? 'sideChat' : 'subThread'
          }
        : {}),
      createdAt: Number.isFinite(chat.createdAt) ? chat.createdAt : 0,
      updatedAt: Number.isFinite(chat.updatedAt) ? chat.updatedAt : 0,
      archived: chat.archived === true,
      messageCount: messages.length,
      runCount: runs.length,
      presentation,
      chrome,
      ...(last
        ? {
            lastRun: copyThreadCatalogueLastRun(last)
          }
        : {})
    },
    recovery: {
      unsettledRuns: runs.filter((run) => run?.runId && chatRunIsReconcilable(run)).length,
      ensembleWakeups: Object.values(chat.ensemble?.wakeups ?? {}).filter(
        (wake) => wake.status === 'pending'
      ).length,
      soloWakeups: Object.values(chat.soloWakeups ?? {}).filter((wake) => wake.status === 'pending')
        .length,
      workerEvents: events.filter((event) =>
        ['pending', 'claimed', 'dispatched'].includes(event.status)
      ).length,
      joinPolicies: joinPolicies.size,
      nextBlackboardExpiryAt: nextBlackboardExpiryAt(chat.ensemble?.blackboard ?? [])
    }
  }
}
