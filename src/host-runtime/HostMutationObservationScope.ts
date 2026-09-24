/**
 * Command-scoped mutation observation.
 *
 * Public Host snapshots are deliberately bounded per family. A mutation diff
 * cannot use that moving global window: inserting one row can evict an
 * unrelated row and manufacture a tombstone. Instead, capture the stable
 * ownership closure named by the command before the ordinary projector runs.
 * Absence inside that closure means absent; unrelated rows are unobserved.
 */

import type { HostCommand, HostResultRef } from '../shared/hostProtocol'
import type { HostSnapshotProjectorInput } from './HostSnapshotProjector'

export type HostMutationObservationFamilies = Omit<
  HostSnapshotProjectorInput,
  'position' | 'recovery'
>

export interface HostMutationObservationScope {
  readonly threadIds: ReadonlySet<string>
  readonly workspaceIds: ReadonlySet<string>
  readonly providerIds: ReadonlySet<string>
  readonly questionIds: ReadonlySet<string>
  readonly approvalIds: ReadonlySet<string>
  readonly channelIds: ReadonlySet<string>
  readonly includeAllWorkspaces: boolean
  /** A direct target without a resolvable owner cannot be narrowed honestly. */
  readonly useFullSnapshot: boolean
}

interface MutableScope {
  threadIds: Set<string>
  workspaceIds: Set<string>
  providerIds: Set<string>
  questionIds: Set<string>
  approvalIds: Set<string>
  channelIds: Set<string>
  includeAllWorkspaces: boolean
  useFullSnapshot: boolean
}

function mutable(scope?: HostMutationObservationScope): MutableScope {
  return {
    threadIds: new Set(scope?.threadIds),
    workspaceIds: new Set(scope?.workspaceIds),
    providerIds: new Set(scope?.providerIds),
    questionIds: new Set(scope?.questionIds),
    approvalIds: new Set(scope?.approvalIds),
    channelIds: new Set(scope?.channelIds),
    includeAllWorkspaces: scope?.includeAllWorkspaces === true,
    useFullSnapshot: scope?.useFullSnapshot === true
  }
}

function freeze(scope: MutableScope): HostMutationObservationScope {
  return {
    threadIds: scope.threadIds,
    workspaceIds: scope.workspaceIds,
    providerIds: scope.providerIds,
    questionIds: scope.questionIds,
    approvalIds: scope.approvalIds,
    channelIds: scope.channelIds,
    includeAllWorkspaces: scope.includeAllWorkspaces,
    useFullSnapshot: scope.useFullSnapshot
  }
}

function addTarget(scope: MutableScope, command: HostCommand): void {
  const target = command.target
  if (typeof target.threadId === 'string') scope.threadIds.add(target.threadId)
  if (typeof target.workspaceId === 'string') scope.workspaceIds.add(target.workspaceId)
  if (typeof target.providerId === 'string') scope.providerIds.add(target.providerId)
  if (typeof target.questionId === 'string') scope.questionIds.add(target.questionId)
  if (typeof target.approvalId === 'string') scope.approvalIds.add(target.approvalId)
  if (typeof target.channelId === 'string') scope.channelIds.add(target.channelId)
  if (command.name === 'workspace.records.clear') scope.includeAllWorkspaces = true
}

function addWorkspaceRegisterMatch(
  scope: MutableScope,
  command: HostCommand,
  families: HostMutationObservationFamilies
): void {
  if (command.name !== 'workspace.register' || typeof command.arguments.path !== 'string') return
  for (const workspace of families.workspaces) {
    if (workspace.path === command.arguments.path) scope.workspaceIds.add(workspace.id)
  }
}

function resolveDirectOwner(
  scope: MutableScope,
  families: HostMutationObservationFamilies,
  requirePresent: boolean
): void {
  for (const questionId of scope.questionIds) {
    const row = families.questions.find((candidate) => candidate.questionId === questionId)
    if (row) scope.threadIds.add(row.threadId)
    else if (requirePresent) scope.useFullSnapshot = true
  }
  for (const approvalId of scope.approvalIds) {
    const row = families.approvals.find((candidate) => candidate.approvalId === approvalId)
    if (row?.threadId) scope.threadIds.add(row.threadId)
    else if (requirePresent) scope.useFullSnapshot = true
  }
  for (const channelId of scope.channelIds) {
    const row = families.channels?.find((candidate) => candidate.channelId === channelId)
    if (row) scope.threadIds.add(row.threadId)
    else if (requirePresent) scope.useFullSnapshot = true
  }
}

export function createHostMutationObservationScope(
  command: HostCommand,
  before: HostMutationObservationFamilies
): HostMutationObservationScope {
  const scope = mutable()
  addTarget(scope, command)
  addWorkspaceRegisterMatch(scope, command, before)
  resolveDirectOwner(scope, before, true)
  return freeze(scope)
}

export function extendHostMutationObservationScope(
  prior: HostMutationObservationScope,
  resultRef: HostResultRef | undefined,
  after: HostMutationObservationFamilies
): HostMutationObservationScope {
  const scope = mutable(prior)
  if (resultRef?.kind === 'thread') scope.threadIds.add(resultRef.threadId)
  if (resultRef?.kind === 'workspace') scope.workspaceIds.add(resultRef.workspaceId)
  if (resultRef?.kind === 'provider-auth') scope.providerIds.add(resultRef.providerId)
  resolveDirectOwner(scope, after, false)
  return freeze(scope)
}

function ownedByThread(threadIds: ReadonlySet<string>, threadId: string | undefined): boolean {
  return typeof threadId === 'string' && threadIds.has(threadId)
}

/**
 * Filter complete donor families by a stable command ownership predicate.
 * No rank/count window participates, so a new UUID cannot evict an unrelated
 * entity and absence has command-local meaning.
 */
export function scopeHostMutationObservationFamilies(
  families: HostMutationObservationFamilies,
  scope: HostMutationObservationScope
): HostMutationObservationFamilies {
  if (scope.useFullSnapshot) return families
  const threadIds = scope.threadIds
  return {
    ...families,
    workspaces: families.workspaces.filter(
      (row) => scope.includeAllWorkspaces || scope.workspaceIds.has(row.id)
    ),
    threads: families.threads.filter((row) => threadIds.has(row.id)),
    runs: families.runs.filter((row) => ownedByThread(threadIds, row.threadId)),
    missions: families.missions.filter((row) => ownedByThread(threadIds, row.threadId)),
    rounds: families.rounds.filter((row) => ownedByThread(threadIds, row.threadId)),
    participants: families.participants.filter((row) => ownedByThread(threadIds, row.threadId)),
    providers: families.providers.filter((row) => scope.providerIds.has(row.providerId)),
    questions: families.questions.filter(
      (row) => scope.questionIds.has(row.questionId) || ownedByThread(threadIds, row.threadId)
    ),
    approvals: families.approvals.filter(
      (row) => scope.approvalIds.has(row.approvalId) || ownedByThread(threadIds, row.threadId)
    ),
    schedules: families.schedules.filter((row) => ownedByThread(threadIds, row.threadId)),
    artifacts: families.artifacts.filter((row) => ownedByThread(threadIds, row.threadId)),
    ...(families.channels
      ? {
          channels: families.channels.filter(
            (row) => scope.channelIds.has(row.channelId) || ownedByThread(threadIds, row.threadId)
          )
        }
      : {})
  }
}
