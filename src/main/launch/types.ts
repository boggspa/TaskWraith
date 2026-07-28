import type { LaunchTarget } from '../launchTargets/types'
import type { ProviderId } from '../store/types'

export type LaunchAttemptStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface LaunchAttempt {
  schemaVersion: 1
  id: string
  targetId: string
  targetLabel: string
  targetSource: LaunchTarget['source']
  targetKind: LaunchTarget['kind']
  targetSnapshot: LaunchTarget
  targetSnapshotHash: string
  provider: ProviderId
  workspaceId?: string
  workspacePath: string
  git?: LaunchTarget['git']
  cwd: string
  commandRaw: string
  argv: string[]
  /** Fresh opaque profile id used only for an approved direct TaskWraith self-launch. */
  isolatedInstanceId?: string
  shell?: boolean
  pid?: number
  pgid?: number
  /**
   * Canonical process-birth receipt captured for this exact spawned PID.
   * Absent when the host cannot resolve one, which keeps native control
   * view-only rather than guessing across possible PID reuse.
   */
  processStartedAt?: string
  status: LaunchAttemptStatus
  startedAt: string
  updatedAt: string
  endedAt?: string
  exitCode?: number | null
  signal?: string | null
  lastError?: string
  outputTail: string
  outputTailBytes: number
  outputTruncated: boolean
  detectedUrls?: string[]
  chatId?: string
  runId?: string
}

export interface LaunchSnapshot {
  sampledAt: string
  attempts: LaunchAttempt[]
}

export interface LaunchStartInput {
  workspacePath: string
  targetId: string
  provider: ProviderId
  chatId?: string
  runId?: string
}

export interface LaunchStopInput {
  attemptId: string
}

export interface LaunchStartResult {
  ok: boolean
  attempt?: LaunchAttempt
  error?: string
}

export interface LaunchStopResult {
  ok: boolean
  attempt?: LaunchAttempt
  error?: string
}
