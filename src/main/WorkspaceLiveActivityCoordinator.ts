/**
 * Collapses multiple active runs in one monitor-authorized workspace into one
 * privacy-safe Live Activity. The coordinator owns presentation only: it does
 * not grant monitor access, cancel runs, mutate Git, or infer authorship.
 *
 * Workspace/thread ids remain Mac-side routing keys. The downstream fanout
 * passes every state through the explicit ActivityKit whitelist, so none of
 * these ids, titles, paths, branches, or ref names enter an APNs payload.
 */

import type { RemoteTaskCard } from './RemoteTaskProjection'
import {
  livePhaseForCardStatus,
  type LiveActivityPushFanout,
  type WorkspaceLiveActivityInput
} from './LiveActivityPushFanout'

export interface WorkspaceActivityGitSnapshot {
  ahead?: unknown
  behind?: unknown
  counts?: { changed?: unknown }
  lineStats?: { additions?: unknown; deletions?: unknown }
  files?: readonly unknown[]
}

export interface WorkspaceActivityProjection {
  workspaceId: string
  memberThreadIds: string[]
  summary: WorkspaceLiveActivityInput
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function startedAtUnix(card: RemoteTaskCard, fallback: number): number {
  const parsed = card.runStartedAt ? Date.parse(card.runStartedAt) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback
}

function seatPhase(status: RemoteTaskCard['status']): string {
  return livePhaseForCardStatus(status) ?? 'running'
}

function active(card: RemoteTaskCard): boolean {
  const phase = livePhaseForCardStatus(card.status)
  return phase !== null && phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled'
}

export function projectWorkspaceLiveActivities(
  cards: readonly RemoteTaskCard[],
  gitSnapshots: ReadonlyMap<string, WorkspaceActivityGitSnapshot>,
  nowSeconds: number
): WorkspaceActivityProjection[] {
  const grouped = new Map<string, RemoteTaskCard[]>()
  for (const card of cards) {
    if (!active(card) || card.isDraft || card.archived) continue
    const workspaceId = card.workspaceId?.trim()
    if (!workspaceId || workspaceId === 'global') continue
    const members = grouped.get(workspaceId) ?? []
    members.push(card)
    grouped.set(workspaceId, members)
  }

  const out: WorkspaceActivityProjection[] = []
  for (const [workspaceId, members] of grouped) {
    if (members.length < 2) continue
    // Capability comes from the active remote allowlist. Mixed capability
    // projection means reconciliation is in flight, so fail closed.
    if (!members.every((card) => card.capabilities?.monitor === true)) continue

    const ordered = [...members].sort((a, b) => {
      const updated = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      return updated !== 0 ? updated : a.id.localeCompare(b.id)
    })
    const phases = ordered.map((card) => livePhaseForCardStatus(card.status))
    const phase = phases.includes('awaitingApproval')
      ? 'awaitingApproval'
      : phases.includes('awaitingQuestion')
        ? 'awaitingQuestion'
        : 'running'
    const git = gitSnapshots.get(workspaceId)
    const changed = git?.counts?.changed
    out.push({
      workspaceId,
      memberThreadIds: ordered.map((card) => card.id),
      summary: {
        workspaceId,
        phase,
        startedAtUnix: Math.min(...ordered.map((card) => startedAtUnix(card, nowSeconds))),
        activeRuns: ordered.length,
        filesChanged:
          changed === undefined ? count(git?.files?.length) : count(git?.counts?.changed),
        additions: count(git?.lineStats?.additions),
        deletions: count(git?.lineStats?.deletions),
        ahead: count(git?.ahead),
        behind: count(git?.behind),
        hasGitSnapshot: git !== undefined,
        seats: ordered.map((card) => ({
          provider: card.provider || (card.chatKind === 'ensemble' ? 'ensemble' : 'codex'),
          phase: seatPhase(card.status)
        }))
      }
    })
  }
  return out.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
}

function runInput(
  card: RemoteTaskCard,
  nowSeconds: number
): Parameters<LiveActivityPushFanout['onTaskCard']>[0] {
  return {
    id: card.id,
    status: card.status,
    runId: card.runId,
    provider: card.provider,
    isEnsemble: card.chatKind === 'ensemble',
    startedAtUnix: startedAtUnix(card, nowSeconds),
    filesChanged: card.diffSummary?.filesChanged,
    additions: card.diffSummary?.additions,
    deletions: card.diffSummary?.deletions,
    seats:
      card.chatKind === 'ensemble'
        ? card.ensembleState?.participants?.map((participant) => ({
            provider: participant.provider,
            phase: seatPhase(participant.status as RemoteTaskCard['status'])
          }))
        : undefined
  }
}

export class WorkspaceLiveActivityCoordinator {
  private readonly fanout: LiveActivityPushFanout
  private readonly now: () => number
  private readonly gitSnapshots = new Map<string, WorkspaceActivityGitSnapshot>()
  private cards: RemoteTaskCard[] = []
  private aggregatedWorkspaceIds = new Set<string>()

  constructor(options: { fanout: LiveActivityPushFanout; now?: () => number }) {
    this.fanout = options.fanout
    this.now = options.now ?? ((): number => Math.floor(Date.now() / 1000))
  }

  reconcile(
    cards: readonly RemoteTaskCard[],
    gitSnapshots?: ReadonlyMap<string, WorkspaceActivityGitSnapshot>
  ): void {
    this.cards = [...cards]
    if (gitSnapshots) {
      this.gitSnapshots.clear()
      for (const [workspaceId, snapshot] of gitSnapshots) {
        this.gitSnapshots.set(workspaceId, snapshot)
      }
    }

    const now = this.now()
    const projections = projectWorkspaceLiveActivities(this.cards, this.gitSnapshots, now)
    const nextWorkspaceIds = new Set(projections.map((projection) => projection.workspaceId))
    const aggregatedThreads = new Set(
      projections.flatMap((projection) => projection.memberThreadIds)
    )

    for (const workspaceId of this.aggregatedWorkspaceIds) {
      if (!nextWorkspaceIds.has(workspaceId)) this.fanout.abandonWorkspace(workspaceId)
    }
    for (const card of this.cards) {
      if (aggregatedThreads.has(card.id)) {
        this.fanout.abandonThread(card.id)
      } else {
        this.fanout.onTaskCard(runInput(card, now))
      }
    }
    for (const projection of projections) {
      this.fanout.onWorkspaceActivity(projection.summary)
    }
    this.aggregatedWorkspaceIds = nextWorkspaceIds
  }

  /** Git watcher fast path. Membership did not change, so update only the
   *  selected workspace summary rather than replaying every run card. */
  updateGitSnapshot(workspaceId: string, snapshot: WorkspaceActivityGitSnapshot): void {
    this.gitSnapshots.set(workspaceId, snapshot)
    if (!this.aggregatedWorkspaceIds.has(workspaceId)) return
    const projection = projectWorkspaceLiveActivities(
      this.cards.filter((card) => card.workspaceId === workspaceId),
      this.gitSnapshots,
      this.now()
    )[0]
    if (projection) this.fanout.onWorkspaceActivity(projection.summary)
  }

  removeGitSnapshot(workspaceId: string): void {
    this.gitSnapshots.delete(workspaceId)
    if (!this.aggregatedWorkspaceIds.has(workspaceId)) return
    const projection = projectWorkspaceLiveActivities(
      this.cards.filter((card) => card.workspaceId === workspaceId),
      this.gitSnapshots,
      this.now()
    )[0]
    if (projection) this.fanout.onWorkspaceActivity(projection.summary)
  }
}
