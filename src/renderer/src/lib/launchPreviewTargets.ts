import type { LaunchAttempt } from '../../../main/launch/types'
import type { LaunchTarget } from '../../../main/launchTargets/types'

export type LaunchPreviewTargetAction = 'open' | 'start' | 'stop' | 'disabled'
export type LaunchPreviewTargetState =
  | 'open'
  | 'startable'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'blocked'
  | 'failed'
  | 'stale'

export interface LaunchPreviewTarget {
  id: string
  label: string
  subtitle: string
  workspacePath: string
  action: LaunchPreviewTargetAction
  state: LaunchPreviewTargetState
  target?: LaunchTarget
  attempt?: LaunchAttempt
  url?: string
  reason?: string
}

const ACTIVE_ATTEMPT_STATUSES = new Set<LaunchAttempt['status']>([
  'starting',
  'running',
  'stopping'
])

function normalizeWorkspacePath(value: string | null | undefined): string {
  if (!value) return ''
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:/i.test(normalized)) return normalized.toLowerCase()
  return normalized
}

function attemptRank(attempt: LaunchAttempt): number {
  if (attempt.status === 'running') return 0
  if (attempt.status === 'starting') return 1
  if (attempt.status === 'stopping') return 2
  if (attempt.status === 'failed') return 3
  return 4
}

function latestAttemptForTarget(
  target: LaunchTarget,
  attempts: LaunchAttempt[]
): LaunchAttempt | undefined {
  const workspacePath = normalizeWorkspacePath(target.workspacePath)
  return attempts
    .filter(
      (attempt) =>
        attempt.targetId === target.id &&
        normalizeWorkspacePath(attempt.workspacePath) === workspacePath
    )
    .sort(
      (a, b) =>
        attemptRank(a) - attemptRank(b) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.startedAt.localeCompare(a.startedAt)
    )[0]
}

function targetSubtitle(target: LaunchTarget): string {
  const parts = [
    target.subtitle,
    target.git?.branch || (target.git?.detached ? 'detached HEAD' : undefined),
    target.platform !== 'unknown' ? target.platform : undefined,
    target.source
  ].filter(Boolean)
  return parts.join(' · ')
}

function requirementSummary(target: LaunchTarget): string {
  const requirement = target.requirements?.find((item) => item.required)
  if (!requirement) return ''
  const optionCount = requirement.options?.length || 0
  return optionCount > 0
    ? `${requirement.label}: ${optionCount} option${optionCount === 1 ? '' : 's'}`
    : requirement.label
}

function targetDisabledReason(target: LaunchTarget, fallback: string): string {
  const requirement = target.requirements?.find((item) => item.required)
  return requirement?.reason || fallback
}

function targetStateFromAttempt(attempt: LaunchAttempt): LaunchPreviewTargetState {
  if (attempt.status === 'starting') return 'starting'
  if (attempt.status === 'stopping') return 'stopping'
  if (attempt.status === 'failed') return 'failed'
  if (attempt.status === 'running') return 'running'
  return 'stale'
}

function attemptPreviewUrl(attempt: LaunchAttempt): string | undefined {
  return attempt.detectedUrls?.[0]
}

function actionFromAttempt(attempt: LaunchAttempt): LaunchPreviewTargetAction {
  if (attemptPreviewUrl(attempt)) return 'open'
  return attempt.status === 'starting' || attempt.status === 'running' ? 'stop' : 'disabled'
}

function buildTargetRow(target: LaunchTarget, attempt?: LaunchAttempt): LaunchPreviewTarget {
  if (attempt && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
    return {
      id: `attempt:${attempt.id}`,
      label: attempt.targetLabel || target.label,
      subtitle:
        attempt.status === 'starting'
          ? 'Starting'
          : attempt.status === 'stopping'
            ? 'Stopping'
            : 'Running',
      workspacePath: attempt.workspacePath,
      action: actionFromAttempt(attempt),
      state: targetStateFromAttempt(attempt),
      target,
      attempt,
      url: attemptPreviewUrl(attempt)
    }
  }

  if (target.url) {
    return {
      id: `open:${target.id}`,
      label: target.label,
      subtitle: targetSubtitle(target) || target.url,
      workspacePath: target.workspacePath,
      action: 'open',
      state: 'open',
      target,
      url: target.url
    }
  }

  if (target.blockers.length > 0) {
    const requirement = requirementSummary(target)
    return {
      id: `blocked:${target.id}`,
      label: target.label,
      subtitle: [targetSubtitle(target), requirement].filter(Boolean).join(' · '),
      workspacePath: target.workspacePath,
      action: 'disabled',
      state: 'blocked',
      target,
      reason: targetDisabledReason(target, target.blockers.join(' '))
    }
  }

  if (target.command?.argv?.length && !target.command.shell) {
    const details = targetSubtitle(target)
    return {
      id: `start:${target.id}`,
      label: target.label,
      subtitle: [target.command.raw, details].filter(Boolean).join(' · '),
      workspacePath: target.workspacePath,
      action: 'start',
      state: 'startable',
      target
    }
  }

  return {
    id: `disabled:${target.id}`,
    label: target.label,
    subtitle: targetSubtitle(target),
    workspacePath: target.workspacePath,
    action: 'disabled',
    state: 'blocked',
    target,
    reason: 'Launch target is not executable by TaskWraith yet.'
  }
}

function staleAttemptRow(attempt: LaunchAttempt): LaunchPreviewTarget {
  return {
    id: `attempt:${attempt.id}`,
    label: attempt.targetLabel,
    subtitle:
      attempt.status === 'starting'
        ? 'Starting from a previous target snapshot'
        : attempt.status === 'stopping'
          ? 'Stopping previous target snapshot'
          : 'Running from a previous target snapshot',
    workspacePath: attempt.workspacePath,
    action: actionFromAttempt(attempt),
    state: targetStateFromAttempt(attempt),
    attempt,
    url: attemptPreviewUrl(attempt)
  }
}

function previewTargetRank(target: LaunchPreviewTarget): number {
  if (target.action === 'open') return 0
  if (target.state === 'running') return 10
  if (target.state === 'starting') return 11
  if (target.action === 'start') return 20
  if (target.state === 'stopping') return 30
  return 40
}

export function buildLaunchPreviewTargets(
  targets: LaunchTarget[],
  attempts: LaunchAttempt[],
  workspacePath: string | null | undefined
): LaunchPreviewTarget[] {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath)
  if (!normalizedWorkspace) return []

  const rows = targets
    .filter((target) => normalizeWorkspacePath(target.workspacePath) === normalizedWorkspace)
    .map((target) => buildTargetRow(target, latestAttemptForTarget(target, attempts)))

  const knownTargetIds = new Set(targets.map((target) => target.id))
  const staleRows = attempts
    .filter(
      (attempt) =>
        ACTIVE_ATTEMPT_STATUSES.has(attempt.status) &&
        normalizeWorkspacePath(attempt.workspacePath) === normalizedWorkspace &&
        !knownTargetIds.has(attempt.targetId)
    )
    .map(staleAttemptRow)

  return [...rows, ...staleRows].sort(
    (a, b) => previewTargetRank(a) - previewTargetRank(b) || a.label.localeCompare(b.label)
  )
}

export function launchPreviewActionTitle(
  targets: LaunchPreviewTarget[],
  hasWorkspace: boolean
): string {
  if (!hasWorkspace) return 'Preview unavailable for global chats'
  if (targets.length === 0) return 'No launch or preview target'
  const first = targets[0]
  if (targets.length === 1 && first) {
    if (first.action === 'open' && first.url) return `Open preview at ${first.url}`
    if (first.action === 'start') return `Start ${first.label}`
    if (first.action === 'stop') return `Stop ${first.label}`
    if (first.action === 'disabled') return first.reason || 'Launch target unavailable'
  }
  return `Choose launch target (${targets.length})`
}
