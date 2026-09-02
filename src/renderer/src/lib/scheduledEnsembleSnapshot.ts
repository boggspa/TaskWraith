import type {
  ChatRecord,
  EnsembleFanoutPolicy,
  ScheduledEnsembleSnapshot
} from '../../../main/store/types'

const ENSEMBLE_FANOUT_POLICIES = new Set<EnsembleFanoutPolicy>([
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
])

function normalizeFanoutPolicy(value: unknown, legacyEnabled?: boolean): EnsembleFanoutPolicy {
  const recognized = ENSEMBLE_FANOUT_POLICIES.has(value as EnsembleFanoutPolicy)
    ? (value as EnsembleFanoutPolicy)
    : legacyEnabled
      ? 'all'
      : 'off'
  // Fan-out is On/Off now: On carries the old 'all' semantics, and the
  // retired 'read_only' / 'locked_writers_*' levels collapse into it.
  return recognized === 'off' ? 'off' : 'all'
}

/**
 * 1.0.4-AT3 — capture a scheduled-task ensemble snapshot from a
 * chat record at schedule time.
 *
 * Returns `null` for non-ensemble chats (the caller schedules a
 * regular single-provider task in that case). Returns a frozen
 * snapshot when the chat has ensemble config: orchestration
 * mode, full participant array, DM/picker routing metadata (if provided), and the
 * cap budgets. `capturedAt` is the ISO timestamp the snapshot
 * was taken — purely informational, surfaced in the task list
 * so users can see "scheduled with roster as of <time>".
 *
 * Pure function so the renderer can unit-test it independently
 * of the IPC/scheduler plumbing.
 */
export function buildScheduledEnsembleSnapshot(
  chat: ChatRecord | null | undefined,
  options: {
    dmTargetParticipantId?: string
    exactPickerParticipantId?: string
    now?: () => Date
  } = {}
): ScheduledEnsembleSnapshot | null {
  if (!chat || chat.chatKind !== 'ensemble' || !chat.ensemble) return null
  const now = (options.now || (() => new Date()))()
  return {
    orchestrationMode:
      // Continuous-only: snapshots always capture (and re-apply) Continuous.
      'continuous',
    fanoutPolicy: normalizeFanoutPolicy(
      chat.ensemble.fanoutPolicy,
      chat.ensemble.concurrentModeEnabled
    ),
    ...(typeof chat.ensemble.concurrentModeEnabled === 'boolean'
      ? { concurrentModeEnabled: chat.ensemble.concurrentModeEnabled }
      : {}),
    participants: chat.ensemble.participants.map((participant) => ({ ...participant })),
    ...(options.dmTargetParticipantId
      ? { dmTargetParticipantId: options.dmTargetParticipantId }
      : {}),
    ...(options.exactPickerParticipantId
      ? { exactPickerParticipantId: options.exactPickerParticipantId }
      : {}),
    ...(typeof chat.ensemble.maxParticipants === 'number'
      ? { maxParticipants: chat.ensemble.maxParticipants }
      : {}),
    ...(typeof chat.ensemble.maxContinuationHops === 'number'
      ? { maxContinuationHops: chat.ensemble.maxContinuationHops }
      : {}),
    capturedAt: now.toISOString()
  }
}

/**
 * 1.0.4-AT3 — apply an ensemble snapshot back onto a chat record
 * so the orchestrator sees the schedule-time roster/mode when
 * firing the task. Returns a new chat (immutable; original is
 * unchanged). The snapshot's `dmTargetParticipantId` is NOT
 * written onto the chat — the caller carries it into the
 * `runEnsembleRound` dispatch payload separately so the chat's
 * own selection isn't perturbed.
 */
export function applyScheduledEnsembleSnapshot(
  chat: ChatRecord,
  snapshot: ScheduledEnsembleSnapshot
): ChatRecord {
  if (!chat.ensemble) return chat
  return {
    ...chat,
    ensemble: {
      ...chat.ensemble,
      orchestrationMode: snapshot.orchestrationMode,
      fanoutPolicy: normalizeFanoutPolicy(snapshot.fanoutPolicy, snapshot.concurrentModeEnabled),
      concurrentModeEnabled:
        typeof snapshot.concurrentModeEnabled === 'boolean'
          ? snapshot.concurrentModeEnabled
          : normalizeFanoutPolicy(snapshot.fanoutPolicy) !== 'off',
      participants: snapshot.participants.map((participant) => ({ ...participant })),
      ...(typeof snapshot.maxParticipants === 'number'
        ? { maxParticipants: snapshot.maxParticipants }
        : {}),
      ...(typeof snapshot.maxContinuationHops === 'number'
        ? { maxContinuationHops: snapshot.maxContinuationHops }
        : {}),
      updatedAt: new Date().toISOString()
    }
  }
}
