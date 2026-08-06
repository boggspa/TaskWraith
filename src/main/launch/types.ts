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
  /**
   * True when TaskWraith did not spawn this process itself but adopted one the
   * run had already started, after proving it descends from this instance and
   * getting explicit human approval. Adopted attempts never record a `pgid`:
   * the group reaches back to the provider process that spawned them.
   */
  adopted?: true
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

/**
 * Adopt a process the agent already started through its own shell, so the
 * Screen Watch / App Drive path can reach it. Never starts anything.
 */
export interface LaunchAdoptInput {
  workspacePath: string
  pid: number
  provider: ProviderId
  chatId?: string
  runId?: string
  /** Human-facing label; the resolved command is shown regardless. */
  label?: string
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
