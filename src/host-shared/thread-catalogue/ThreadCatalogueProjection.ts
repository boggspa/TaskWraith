import { isSafeChatId } from '../../shared/ChatPath'
import {
  copyThreadCatalogueChrome,
  copyThreadCatalogueLastRun,
  copyThreadCatalogueControlFacts
} from './ThreadCatalogueChrome'
import type { ThreadCatalogueProjection, ThreadCatalogueSummary } from './ThreadCatalogue'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalStrings(
  input: Record<string, unknown>,
  fields: Readonly<Record<string, number>>
): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const [field, maximum] of Object.entries(fields)) {
    const value = input[field]
    if (value === undefined) continue
    if (!text(value, maximum)) return null
    result[field] = value
  }
  return result
}

/**
 * Copy only a fixed set of bounded fields. Never stringify or walk unknown
 * fields first: a mistakenly supplied record may contain gigabytes of history.
 */
export function copyThreadCatalogueProjection(
  value: unknown,
  chatId: string
): ThreadCatalogueProjection | null {
  const input = object(value)
  const summary = object(input?.summary)
  const recovery = object(input?.recovery)
  if (
    !input ||
    !summary ||
    !recovery ||
    summary.chatId !== chatId ||
    !isSafeChatId(chatId) ||
    !text(summary.title, 2048) ||
    !text(summary.provider, 128) ||
    (summary.chatKind !== 'single' && summary.chatKind !== 'ensemble') ||
    (summary.scope !== 'global' && summary.scope !== 'workspace') ||
    !finite(summary.createdAt) ||
    !finite(summary.updatedAt) ||
    typeof summary.archived !== 'boolean' ||
    !count(summary.messageCount) ||
    !count(summary.runCount) ||
    !count(input.revision) ||
    !count(recovery.unsettledRuns) ||
    !count(recovery.ensembleWakeups) ||
    !count(recovery.soloWakeups) ||
    !count(recovery.workerEvents) ||
    !count(recovery.joinPolicies) ||
    (recovery.nextBlackboardExpiryAt !== null && !finite(recovery.nextBlackboardExpiryAt))
  )
    return null

  const optional = optionalStrings(summary, {
    workspaceId: 512,
    workspacePath: 4096,
    parentChatId: 256
  })
  if (!optional || (optional.parentChatId !== undefined && !isSafeChatId(optional.parentChatId)))
    return null
  const relation = summary.parentChatRelation
  if (relation !== undefined && relation !== 'sideChat' && relation !== 'subThread') return null
  let lastRun: ThreadCatalogueSummary['lastRun']
  if (summary.lastRun !== undefined) {
    const run = object(summary.lastRun)
    if (!run || !text(run.runId, 512)) return null
    const optionalRun = optionalStrings(run, {
      provider: 128,
      status: 64,
      startedAt: 64,
      endedAt: 64
    })
    if (!optionalRun) return null
    lastRun = copyThreadCatalogueLastRun(run)
  }
  const p = object(summary.presentation)
  const presentation =
    p &&
    [
      'idle',
      'queued',
      'running',
      'awaitingApproval',
      'awaitingQuestion',
      'success',
      'failed',
      'cancelled'
    ].includes(String(p.status)) &&
    count(p.runningRunCount)
      ? {
          status: p.status as NonNullable<ThreadCatalogueSummary['presentation']>['status'],
          runningRunCount: p.runningRunCount,
          ...(text(p.runId, 512) ? { runId: p.runId } : {}),
          ...(text(p.startedAt, 64) ? { startedAt: p.startedAt } : {})
        }
      : undefined
  return {
    revision: input.revision,
    ...(input.sourceComplete === false ? { sourceComplete: false as const } : {}),
    summary: {
      chatId,
      title: summary.title,
      provider: summary.provider,
      chatKind: summary.chatKind,
      scope: summary.scope,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      messageCount: summary.messageCount,
      runCount: summary.runCount,
      ...(presentation ? { presentation } : {}),
      ...(summary.control ? { control: copyThreadCatalogueControlFacts(summary.control) } : {}),
      ...(summary.chrome === undefined
        ? {}
        : { chrome: copyThreadCatalogueChrome(summary.chrome) }),
      ...optional,
      ...(relation === undefined ? {} : { parentChatRelation: relation }),
      ...(lastRun === undefined ? {} : { lastRun })
    },
    recovery: {
      unsettledRuns: recovery.unsettledRuns,
      ensembleWakeups: recovery.ensembleWakeups,
      soloWakeups: recovery.soloWakeups,
      workerEvents: recovery.workerEvents,
      joinPolicies: recovery.joinPolicies,
      nextBlackboardExpiryAt: recovery.nextBlackboardExpiryAt
    }
  }
}
