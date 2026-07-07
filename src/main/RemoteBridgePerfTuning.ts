import type { RunSessionStatus } from './RunManager'

export const REMOTE_LIVE_SNAPSHOT_INTERVAL_MS = 600
export const REMOTE_PROJECTION_SNAPSHOT_IDLE_THROTTLE_MS = 1_000
export const REMOTE_PROJECTION_SNAPSHOT_STREAMING_THROTTLE_MS = 2_500

export interface RemoteBridgeRunSessionLike {
  appChatId?: string | null
  status?: RunSessionStatus | string
}

export interface RemoteLiveSnapshotScheduler {
  clear(threadId: string): void
  schedule(threadId: string): void
}

export interface RemoteLiveSnapshotSchedulerOptions {
  intervalMs?: number
  now?: () => number
  push: (threadId: string) => boolean
}

export function remoteLiveSnapshotDelayMs(
  nowMs: number,
  lastPushMs: number | undefined,
  intervalMs = REMOTE_LIVE_SNAPSHOT_INTERVAL_MS
): number {
  if (lastPushMs === undefined) return 0
  const elapsed = nowMs - lastPushMs
  if (!Number.isFinite(elapsed)) return 0
  return elapsed >= intervalMs ? 0 : Math.max(0, intervalMs - elapsed)
}

export function createRemoteLiveSnapshotScheduler(
  options: RemoteLiveSnapshotSchedulerOptions
): RemoteLiveSnapshotScheduler {
  const intervalMs = options.intervalMs ?? REMOTE_LIVE_SNAPSHOT_INTERVAL_MS
  const now = options.now ?? Date.now
  const lastPushMs = new Map<string, number>()
  const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clear = (threadId: string): void => {
    const timer = trailingTimers.get(threadId)
    if (!timer) return
    clearTimeout(timer)
    trailingTimers.delete(threadId)
  }

  const push = (threadId: string): void => {
    if (options.push(threadId)) {
      lastPushMs.set(threadId, now())
    }
  }

  const schedule = (threadId: string): void => {
    const delayMs = remoteLiveSnapshotDelayMs(now(), lastPushMs.get(threadId), intervalMs)
    if (delayMs <= 0) {
      clear(threadId)
      push(threadId)
      return
    }
    if (trailingTimers.has(threadId)) return
    const timer = setTimeout(() => {
      trailingTimers.delete(threadId)
      push(threadId)
    }, delayMs)
    timer.unref?.()
    trailingTimers.set(threadId, timer)
  }

  return { clear, schedule }
}

export function hasStreamingRemoteRunSessions(
  sessions: readonly RemoteBridgeRunSessionLike[]
): boolean {
  return sessions.some((session) => Boolean(session.appChatId) && session.status === 'running')
}

export function remoteProjectionSnapshotThrottleMsForStreaming(
  hasStreamingRun: boolean
): number {
  return hasStreamingRun
    ? REMOTE_PROJECTION_SNAPSHOT_STREAMING_THROTTLE_MS
    : REMOTE_PROJECTION_SNAPSHOT_IDLE_THROTTLE_MS
}
