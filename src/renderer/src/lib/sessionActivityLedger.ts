import type {
  ChatMessage,
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  PermissionOverrides,
  ProviderId,
  SessionActivityLedgerEntry
} from '../../../main/store/types'

const SESSION_ACTIVITY_LEDGER_LIMIT = 40

const PROVIDER_LABELS: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'Antigravity',
  pi: 'Pi'
}

export function withSessionActivityLedger(
  previous: ChatRecord,
  next: ChatRecord,
  changedBy: SessionActivityLedgerEntry['changedBy'] = 'user'
): ChatRecord {
  if (!previous.ensemble || !next.ensemble) return next
  const entries = collectSessionActivityEntries(previous, next, changedBy)
  if (entries.length === 0) return next
  return {
    ...next,
    ensemble: appendSessionActivityEntries(next.ensemble, entries)
  }
}

export function appendSessionActivityEntries(
  ensemble: EnsembleConfig,
  entries: SessionActivityLedgerEntry[]
): EnsembleConfig {
  if (entries.length === 0) return ensemble
  const prior = ensemble.sessionActivityLedger || []
  return {
    ...ensemble,
    sessionActivityLedger: [...prior, ...entries].slice(-SESSION_ACTIVITY_LEDGER_LIMIT)
  }
}

function collectSessionActivityEntries(
  previous: ChatRecord,
  next: ChatRecord,
  changedBy: SessionActivityLedgerEntry['changedBy']
): SessionActivityLedgerEntry[] {
  const entries: SessionActivityLedgerEntry[] = []
  const add = (entry: Omit<SessionActivityLedgerEntry, 'id' | 'timestamp' | 'changedBy'>) => {
    entries.push({
      id: nextSessionActivityId(),
      timestamp: new Date().toISOString(),
      changedBy,
      ...entry
    })
  }

  if (previous.scope !== next.scope || previous.workspacePath !== next.workspacePath) {
    add({
      scope: 'session',
      target: 'workspace',
      oldValue: previous.workspacePath || previous.scope || null,
      newValue: next.workspacePath || next.scope || null,
      reason:
        next.workspacePath === previous.workspacePath
          ? 'Workspace scope changed for this Ensemble chat.'
          : 'Workspace binding changed for this Ensemble chat.'
    })
  }

  const previousParticipants = new Map(
    previous.ensemble!.participants.map((participant) => [participant.id, participant])
  )
  const nextParticipants = new Map(
    next.ensemble!.participants.map((participant) => [participant.id, participant])
  )

  for (const [id, participant] of nextParticipants) {
    const before = previousParticipants.get(id)
    if (!before) {
      add({
        scope: 'participant',
        target: id,
        oldValue: null,
        newValue: participantLabel(participant),
        reason: 'Participant added to the Ensemble roster.'
      })
      continue
    }
    if (
      before.provider !== participant.provider ||
      normalizedRole(before) !== normalizedRole(participant)
    ) {
      add({
        scope: 'participant',
        target: id,
        oldValue: participantLabel(before),
        newValue: participantLabel(participant),
        reason:
          before.provider !== participant.provider
            ? 'Participant provider changed.'
            : 'Participant role/name changed.'
      })
    }
    if (before.enabled !== participant.enabled) {
      add({
        scope: 'participant',
        target: participantLabel(participant),
        oldValue: before.enabled ? 'enabled' : 'disabled',
        newValue: participant.enabled ? 'enabled' : 'disabled',
        reason: 'Participant availability changed.'
      })
    }
    if ((before.permissionPresetId || '') !== (participant.permissionPresetId || '')) {
      add({
        scope: 'participant',
        target: `${participantLabel(participant)} permission preset`,
        oldValue: before.permissionPresetId || null,
        newValue: participant.permissionPresetId || null,
        reason: 'Participant permission preset changed.'
      })
    }
    if (
      stableStringify(before.permissionOverrides) !==
      stableStringify(participant.permissionOverrides)
    ) {
      add({
        scope: 'participant',
        target: `${participantLabel(participant)} permission overrides`,
        oldValue: permissionOverrideSummary(before.permissionOverrides),
        newValue: permissionOverrideSummary(participant.permissionOverrides),
        reason: 'Participant permission overrides changed.'
      })
    }
    if ((before.instructions || '').trim() !== (participant.instructions || '').trim()) {
      add({
        scope: 'participant',
        target: `${participantLabel(participant)} instructions`,
        oldValue: before.instructions?.trim() ? 'custom instructions' : null,
        newValue: participant.instructions?.trim() ? 'custom instructions' : null,
        reason: 'Participant role instructions changed.'
      })
    }
  }

  for (const [id, participant] of previousParticipants) {
    if (nextParticipants.has(id)) continue
    add({
      scope: 'participant',
      target: id,
      oldValue: participantLabel(participant),
      newValue: null,
      reason: 'Participant removed from the Ensemble roster.'
    })
  }

  const oldMode = previous.ensemble!.orchestrationMode || 'turn_bound'
  const newMode = next.ensemble!.orchestrationMode || 'turn_bound'
  if (oldMode !== newMode) {
    add({
      scope: 'session',
      target: 'orchestration mode',
      oldValue: oldMode,
      newValue: newMode,
      reason: 'Ensemble turn policy changed.'
    })
  }

  return entries
}

function participantLabel(participant: EnsembleParticipant): string {
  return `${PROVIDER_LABELS[participant.provider] || participant.provider} / ${
    normalizedRole(participant) || 'Participant'
  }`
}

function permissionOverrideSummary(overrides: PermissionOverrides | undefined): string | null {
  if (!overrides) return null
  const parts: string[] = []
  if (overrides.approvalMode) parts.push('approval policy')
  if (overrides.networkAccess) parts.push('network policy')
  const serviceCount = Object.keys(overrides.agenticServices || {}).length
  if (serviceCount > 0) {
    parts.push(`${serviceCount} service ${serviceCount === 1 ? 'rule' : 'rules'}`)
  }
  const grantCount = overrides.externalPathGrants?.length || 0
  if (grantCount > 0) {
    parts.push(`${grantCount} external path ${grantCount === 1 ? 'grant' : 'grants'}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'empty overrides'
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function normalizedRole(participant: EnsembleParticipant): string {
  return String(participant.role || '').trim()
}

function nextSessionActivityId(): string {
  return `session-event-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 1.0.7 — participant-rename continuity for the transcript.
 *
 * An assistant message freezes the role its author held at the time
 * (`metadata.ensembleRole`). When the user later renames that seat
 * ("Planner" → "Architect"), a reader scrolling the transcript can't
 * tell the earlier "Planner" message and the seat now called
 * "Architect" are the SAME participant. This derives a quiet
 * "renamed from <role>" continuity note for such a message.
 *
 * Resolution order (per the dogfood-triage spec):
 *   1. PREFER the session-activity ledger's explicit old→new rename
 *      entry for this participant id, when one is still present (the
 *      ledger is the authoritative record of the transition, with a
 *      reason string). We require the entry's recorded NEW role to
 *      match the seat's CURRENT role so a stale intermediate rename
 *      (Planner→Architect, then Architect→Lead) doesn't mislabel a
 *      Lead seat as "renamed from Planner".
 *   2. FALLBACK (required — the ledger is capped/sliced, so a rename
 *      can age out): compare the message's FROZEN role against the
 *      participant's CURRENT role looked up by id. If they differ,
 *      still surface the note using the frozen role as the "from".
 *
 * Returns `null` when there's nothing to show (no id, no current
 * seat, roles match, or the message isn't an ensemble assistant
 * message). The frozen `ensembleRole` on the message is never
 * mutated — this is a read-only derivation for display.
 */
export interface ParticipantRenameContinuity {
  /** The role the message was authored under (or the ledger's
   * recorded prior role) — the "renamed from X" value. */
  fromRole: string
  /** The participant's current role — useful for a tooltip/aria
   * ("Now: Architect"). */
  currentRole: string
}

export function deriveParticipantRenameContinuity(
  message: Pick<ChatMessage, 'role' | 'metadata'>,
  participants: readonly EnsembleParticipant[] | undefined,
  ledger: readonly SessionActivityLedgerEntry[] | undefined
): ParticipantRenameContinuity | null {
  if (message.role !== 'assistant' || !message.metadata) return null
  const metadata = message.metadata
  const participantId =
    typeof metadata.ensembleParticipantId === 'string' ? metadata.ensembleParticipantId : ''
  if (!participantId || !participants || participants.length === 0) return null
  const current = participants.find((participant) => participant.id === participantId)
  if (!current) return null
  const currentRole = normalizedRole(current)
  if (!currentRole) return null
  const frozenRole = typeof metadata.ensembleRole === 'string' ? metadata.ensembleRole.trim() : ''

  // A message authored under the seat's CURRENT name needs no note,
  // even if the seat churned through other names and back — the label
  // the reader sees already matches the live roster. This also guards
  // the rename-then-rename-back case from a false positive.
  if (frozenRole && frozenRole === currentRole) return null

  // 1. Ledger-preferred. Scan newest→oldest for a role-rename entry
  //    targeting this participant whose recorded NEW role equals the
  //    current role. Its recorded OLD role is the authoritative
  //    "from". Requiring the new role to match current stops a stale
  //    intermediate rename (Planner→Architect, then Architect→Lead)
  //    from mislabelling a Lead seat as "renamed from Planner".
  if (ledger && ledger.length > 0) {
    for (let i = ledger.length - 1; i >= 0; i -= 1) {
      const entry = ledger[i]
      if (entry.scope !== 'participant') continue
      // Rename/provider-change entries target the raw participant id
      // (other participant events target the label) — so this filter
      // selects only identity-changing entries for this seat.
      if (entry.target !== participantId) continue
      const oldRole = roleFromLabel(entry.oldValue)
      const newRole = roleFromLabel(entry.newValue)
      if (!oldRole || !newRole) continue
      if (newRole !== currentRole) continue
      if (oldRole === currentRole) continue
      // When the message carries a frozen role, only trust the ledger
      // entry if it matches THIS message's transition; otherwise the
      // frozen role is the per-message-accurate "from" (handled by the
      // fallback below).
      if (frozenRole && oldRole !== frozenRole) break
      return { fromRole: oldRole, currentRole }
    }
  }

  // 2. Fallback: frozen-vs-current compare (the required path when the
  //    ledger has aged the rename out, or carries no matching entry).
  if (frozenRole && frozenRole !== currentRole) {
    return { fromRole: frozenRole, currentRole }
  }
  return null
}

/**
 * Extract the role half of a "Provider / Role" ledger label. Ledger
 * rename entries store oldValue/newValue as `participantLabel`
 * output (e.g. "Claude / Explorer"); the role is the segment after
 * the LAST " / " so provider names containing a slash (none today,
 * but defensive) don't truncate the role. Returns '' when the label
 * is empty/unparseable.
 */
function roleFromLabel(label: string | null | undefined): string {
  const text = String(label || '').trim()
  if (!text) return ''
  const idx = text.lastIndexOf(' / ')
  return idx >= 0 ? text.slice(idx + 3).trim() : text
}
