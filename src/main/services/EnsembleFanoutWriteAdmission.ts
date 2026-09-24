export interface EnsembleFanoutLaneAdmissionCandidate {
  participantId: string
  participantLabel: string
  intent: 'read' | 'write'
  approvedWriteScopeCount: number
}

export interface EnsembleFanoutLaneIntentInput {
  mode: 'read_only' | 'locked_writers'
  permissionReadOnly: boolean
  deriveLaneIntentFromPermissions?: boolean
}

/**
 * Permission posture controls which tools can run without redundant prompts;
 * fan-out mode controls what the lane is assigned to do. Only an explicitly
 * authorized own-posture route may derive write intent from a writable seat
 * during a read-only pass.
 */
export function resolveEnsembleFanoutLaneIntent({
  mode,
  permissionReadOnly,
  deriveLaneIntentFromPermissions = false
}: EnsembleFanoutLaneIntentInput): 'read' | 'write' {
  if (permissionReadOnly) return 'read'
  return mode === 'read_only' && !deriveLaneIntentFromPermissions ? 'read' : 'write'
}

export type EnsembleFanoutWriteAdmission =
  | { ok: true }
  | {
      ok: false
      missingParticipantIds: string[]
      message: string
    }

/**
 * A write-capable permission preset is not a parallel-lane write grant.
 * Every write-intent lane needs host-approved scopes before the provider is
 * invoked; otherwise the workspace gate can only reject its eventual edits.
 */
export function evaluateEnsembleFanoutWriteAdmission(
  candidates: readonly EnsembleFanoutLaneAdmissionCandidate[]
): EnsembleFanoutWriteAdmission {
  const missing = candidates.filter(
    (candidate) =>
      candidate.intent === 'write' &&
      (!Number.isFinite(candidate.approvedWriteScopeCount) ||
        candidate.approvedWriteScopeCount <= 0)
  )
  if (missing.length === 0) return { ok: true }

  const labels = missing.map((candidate) => candidate.participantLabel || candidate.participantId)
  return {
    ok: false,
    missingParticipantIds: missing.map((candidate) => candidate.participantId),
    message: `Parallel writer admission rejected before provider dispatch: ${labels.join(', ')} ${missing.length === 1 ? 'has' : 'have'} write intent but no approved writeScopes. Seat permission, Full WS Access, or caller seniority cannot satisfy a lane scope. Use ensemble_fanout with mode="locked_writers" and writeScopes keyed by every writer target, or leave those targets for serial rotation.`
  }
}
