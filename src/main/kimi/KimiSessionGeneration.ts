// Transport-generation fence for Kimi session ids (dossier slice 5).
//
// Legacy Wire and Kimi Code ACP mint incompatible session artifacts:
//   - ACP session/new returns `session_<uuid>` (verified live on 0.24.1).
//   - the legacy Wire CLI mints a bare `<uuid>` (verified from migrated
//     state.json custom.kimi_cli_session_id).
// Feeding one generation's id to the other's resume is a silent hazard: a
// `session_<uuid>` handed to legacy `--resume` either errors or, worse,
// prefix-matches a different session. The ACP transport never resumes (it
// opens a fresh session/new every turn, Grok-parity), so the only crossing
// that can happen in practice is a stored ACP id reaching the retained Wire
// path after a rollback / flag flip. This guard refuses that crossing: the
// Wire path resumes ONLY a Wire-generation id, and starts fresh otherwise
// (never guesses across generations).
//
// A full persisted generation tag on linkedProviderSessionId (store/types.ts)
// is the dossier's belt-and-braces follow-up; this prefix classifier closes
// the practical hazard without the coordinated schema change.

export type KimiSessionGeneration = 'acp' | 'wire' | 'unknown'

/** ACP session ids carry the `session_` prefix; legacy Wire ids are bare uuids. */
export function classifyKimiSessionGeneration(
  sessionId: string | null | undefined
): KimiSessionGeneration {
  const id = String(sessionId || '').trim()
  if (!id) return 'unknown'
  if (id.startsWith('session_')) return 'acp'
  return 'wire'
}

/**
 * The session id to pass to the legacy Wire `--resume`, or null to start fresh.
 * A Wire-generation id resumes; an ACP-generation id is refused (cross-
 * generation resume) so the Wire CLI never receives a `session_` id it cannot
 * resolve.
 */
export function wireResumeSessionId(sessionId: string | null | undefined): string | null {
  const id = String(sessionId || '').trim()
  if (!id) return null
  return classifyKimiSessionGeneration(id) === 'wire' ? id : null
}
