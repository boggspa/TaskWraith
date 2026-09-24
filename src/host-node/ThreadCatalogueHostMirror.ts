import type {
  HostProfileRun,
  HostProfileThread,
  HostProfileThreadSummary
} from '../host-runtime/HostProfileDomainStore'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import {
  buildThreadCatalogueSearchText,
  computeThreadCatalogueSearchScan,
  copyThreadCatalogueChrome,
  copyThreadCatalogueLastRun
} from '../host-shared/thread-catalogue/ThreadCatalogueChrome'
import type { ThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogue'
import { copyThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogueProjection'
import { isActiveChatRunStatus } from '../shared/chatRunStatus'
import {
  projectThreadRunWallMs,
  type ThreadEnsembleWallTimeSource
} from '../shared/threadRunWallTime'
import { isEnsembleRoundPresentationLive } from '../shared/ensembleRoundLifecycle'
import type {
  ThreadCatalogueRequestOptions,
  ThreadCatalogueReadQuery,
  ThreadCatalogueWireReply
} from '../shared/threadCatalogueProtocol'
import { threadCatalogueRequestError } from '../shared/threadCatalogueRequestError'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function values(value: unknown): Record<string, unknown>[] {
  const object = record(value)
  return object
    ? Object.values(object).flatMap((entry) => (record(entry) ? [record(entry)!] : []))
    : []
}

function latestRun(runs: readonly HostProfileRun[]): HostProfileRun | undefined {
  let latest: HostProfileRun | undefined
  let latestAt = -1
  for (const run of runs) {
    const at = Date.parse(run.startedAt ?? '')
    const comparable = Number.isFinite(at) ? at : 0
    if (!latest || comparable >= latestAt) {
      latest = run
      latestAt = comparable
    }
  }
  return latest
}

function taskStatus(
  run: HostProfileRun | undefined,
  ensemble: Record<string, unknown> | null
): NonNullable<ThreadCatalogueProjection['summary']['presentation']>['status'] {
  if (
    isEnsembleRoundPresentationLive(
      record(ensemble?.activeRound) as Parameters<typeof isEnsembleRoundPresentationLive>[0]
    )
  )
    return 'running'
  if (!run) return 'idle'
  if (run.status === 'running') return 'running'
  if (
    run.status === 'cancelled' ||
    run.status === 'canceled' ||
    (run as { cancelled?: unknown }).cancelled === true
  )
    return 'cancelled'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'success' || run.status === 'success_with_warnings') return 'success'
  return 'idle'
}

function localChrome(thread: HostProfileThread): ReturnType<typeof copyThreadCatalogueChrome> {
  const chrome = copyThreadCatalogueChrome(thread)
  // The shared scan — identical output to the desktop projection, or the
  // mirror's equality gate fans a saveless invalidation out per poll pass.
  const scan = computeThreadCatalogueSearchScan(thread.messages)
  chrome.searchPreview = scan.preview
  chrome.searchText = buildThreadCatalogueSearchText({
    title: thread.title,
    provider: thread.provider,
    chatId: thread.appChatId,
    recent: scan.recent
  })
  if (scan.lastUserMessageAt !== undefined) chrome.lastUserMessageAt = scan.lastUserMessageAt
  return chrome
}

/** Bounded read-your-write projection from the Host record already in memory. */
export function projectHostCatalogueThread(thread: HostProfileThread): ThreadCatalogueProjection {
  const runs = Array.isArray(thread.runs) ? thread.runs : []
  const last = runs.at(-1)
  const presentationRun = latestRun(runs)
  const ensemble = record(thread.ensemble)
  const workerControl = record(record(thread.delegationContext)?.workerControl)
  const events = Array.isArray(workerControl?.events)
    ? workerControl.events.flatMap((entry) => (record(entry) ? [record(entry)!] : []))
    : []
  const joinPolicies = new Set<string>()
  const rootJoin = record(record(thread.delegationContext)?.joinPolicy)?.groupId
  if (typeof rootJoin === 'string') joinPolicies.add(rootJoin)
  for (const event of events) {
    const id = record(event.joinPolicy)?.groupId
    if (typeof id === 'string') joinPolicies.add(id)
  }
  let nextBlackboardExpiryAt: number | null = null
  const blackboard = Array.isArray(ensemble?.blackboard) ? ensemble.blackboard : []
  for (const item of blackboard) {
    const expiry = Date.parse(String(record(item)?.expiresAt ?? ''))
    if (
      Number.isFinite(expiry) &&
      (nextBlackboardExpiryAt === null || expiry < nextBlackboardExpiryAt)
    )
      nextBlackboardExpiryAt = expiry
  }
  const candidate: ThreadCatalogueProjection = {
    revision:
      Number.isSafeInteger(thread.persistenceRevision) && (thread.persistenceRevision ?? -1) >= 0
        ? thread.persistenceRevision!
        : 0,
    summary: {
      chatId: thread.appChatId,
      title: String(thread.title ?? '').slice(0, 2048),
      provider: String(thread.provider ?? '').slice(0, 128),
      chatKind: thread.chatKind === 'ensemble' ? 'ensemble' : 'single',
      scope: thread.scope === 'global' ? 'global' : 'workspace',
      ...(thread.scope !== 'global' && thread.workspaceId
        ? { workspaceId: thread.workspaceId }
        : {}),
      ...(thread.scope !== 'global' && thread.workspacePath
        ? { workspacePath: thread.workspacePath }
        : {}),
      ...(typeof thread.parentChatId === 'string'
        ? {
            parentChatId: thread.parentChatId,
            parentChatRelation: thread.parentChatRelation === 'sideChat' ? 'sideChat' : 'subThread'
          }
        : {}),
      createdAt: Number.isFinite(thread.createdAt) ? Number(thread.createdAt) : 0,
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0,
      archived: thread.archived === true,
      messageCount: thread.messages.length,
      runCount: runs.length,
      runWallMs: projectThreadRunWallMs(runs, ensemble as ThreadEnsembleWallTimeSource | null),
      chrome: localChrome(thread),
      presentation: {
        status: taskStatus(presentationRun, ensemble),
        ...(presentationRun?.runId ? { runId: presentationRun.runId } : {}),
        ...(presentationRun?.startedAt ? { startedAt: presentationRun.startedAt } : {}),
        runningRunCount: runs.filter((run) => run.status === 'running').length
      },
      ...(last ? { lastRun: copyThreadCatalogueLastRun(last) } : {})
    },
    recovery: {
      unsettledRuns: runs.filter(
        (run) => isActiveChatRunStatus(run.status) || (run.status === undefined && !run.endedAt)
      ).length,
      ensembleWakeups: values(ensemble?.wakeups).filter((wake) => wake.status === 'pending').length,
      soloWakeups: values(thread.soloWakeups).filter((wake) => wake.status === 'pending').length,
      workerEvents: events.filter((event) =>
        ['pending', 'claimed', 'dispatched'].includes(String(event.status))
      ).length,
      joinPolicies: joinPolicies.size,
      nextBlackboardExpiryAt
    }
  }
  const bounded = copyThreadCatalogueProjection(candidate, thread.appChatId)
  if (!bounded) throw new Error('Host thread metadata projection is invalid')
  return bounded
}

export function hostCatalogueSummaries(mirror: ThreadCatalogueMirror): HostProfileThreadSummary[] {
  return mirror.projections().map(({ summary: row, revision }) => {
    const run = row.lastRun
    return {
      ...row.chrome,
      ...row,
      catalogueProjection: true,
      cataloguePresentation: row.presentation,
      appChatId: row.chatId,
      persistenceRevision: revision,
      scope: row.scope === 'global' ? 'global' : 'workspace',
      latestPreview: row.chrome?.searchPreview,
      runs: run
        ? [
            {
              runId: run.runId,
              provider: run.provider,
              status: run.status,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              requestedModel: run.requestedModel
            }
          ]
        : []
    }
  })
}

export async function queryHostCatalogue(
  client: ThreadCatalogueClient,
  request: ThreadCatalogueReadQuery,
  options: ThreadCatalogueRequestOptions = {}
): Promise<ThreadCatalogueWireReply> {
  try {
    const data = await client.query(request, options)
    return {
      data:
        data instanceof Uint8Array
          ? { encoding: 'base64', bytes: Buffer.from(data).toString('base64') }
          : data
    }
  } catch (error) {
    const requestError = threadCatalogueRequestError(error)
    if (!requestError) throw error
    return { data: null, error: { code: requestError.code } }
  }
}
