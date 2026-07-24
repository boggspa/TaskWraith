/**
 * 1.0.4-AK6 — `scout_brief` MCP tool handler.
 *
 * Called by a participant at the end of their parallel fan-out
 * lane (see `runParallelFanoutPass` in `EnsembleOrchestrator.ts`)
 * to emit a structured summary of what they found. The serial
 * writer step that follows the parallel pass ingests these briefs
 * via the system prompt so the writer has a coherent picture of
 * the panel's read-only findings before acting.
 *
 * The module is side-effect-free at the
 * surface — it takes a `deps` interface, validates the args, and
 * the orchestrator caller persists the brief into runtime state.
 * Keeping the handler pure makes the regression suite trivially
 * unit-testable.
 *
 * Critical safety: this tool is a NO-OP outside an active parallel
 * fan-out pass. Calling it from a serial round, or from a writer
 * participant inside a read-only fan-out pass, returns a structured error
 * rather than silently logging — the agents need to know when
 * they're outside the intended call site so they don't waste a
 * turn on a no-op.
 */
import type { ProviderId } from './store/types'

export type ScoutBriefConfidence = 'high' | 'medium' | 'low'

export interface ScoutBriefArgs {
  /** What the scout discovered. Required, sanitised + truncated. */
  findings?: string
  /** Confidence rating — 'high' | 'medium' | 'low'. Required. */
  confidence?: ScoutBriefConfidence
  /** Optional list of blockers the writer should know about. */
  blockers?: string[]
  /** Optional recommendations the writer should weigh. */
  recommendations?: string[]
  /** Optional tags for filtering / grouping briefs across passes. */
  tags?: string[]
}

export interface ScoutBriefRecord {
  participantId: string
  participantRole: string
  provider: ProviderId
  findings: string
  confidence: ScoutBriefConfidence
  blockers?: string[]
  recommendations?: string[]
  tags?: string[]
  emittedAt: string
}

export interface ScoutBriefDeps {
  /** Lookup the calling participant's id (from the orchestrator's
   * run registry). Returns null when the call originated outside
   * an ensemble run. */
  getParticipantIdForRun(runId: string): string | null
  /** Lookup the participant's role + provider via the runtime. */
  getParticipantMeta(runId: string): { role: string; provider: ProviderId } | null
  /** Returns `true` when the run is currently part of a parallel
   * fan-out pass (orchestrator's active fan-out set contains
   * the runId). The handler refuses to record briefs outside this
   * window so writers can't accidentally call it. */
  isParticipantInScoutPass(runId: string): boolean
  /** Record the brief into runtime state. The orchestrator threads
   * recorded briefs into the writer's prompt context after the
   * fan-out pass closes. */
  recordScoutBrief(runId: string, brief: ScoutBriefRecord): void
}

export interface ScoutBriefResult {
  ok: boolean
  message: string
  /** Set when ok=false; categorises the failure. */
  error?:
    | 'no_active_scout_pass'
    | 'unknown_participant'
    | 'missing_findings'
    | 'invalid_confidence'
    | 'unknown'
}

const VALID_CONFIDENCE: readonly ScoutBriefConfidence[] = ['high', 'medium', 'low']
const MAX_FINDINGS_LENGTH = 4000
const MAX_LIST_ITEMS = 8
const MAX_LIST_ITEM_LENGTH = 240

function sanitiseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_LIST_ITEMS)
    .map((entry) => entry.slice(0, MAX_LIST_ITEM_LENGTH))
}

export function handleScoutBrief(
  runId: string,
  args: ScoutBriefArgs,
  deps: ScoutBriefDeps
): ScoutBriefResult {
  if (!runId || !deps.isParticipantInScoutPass(runId)) {
    return {
      ok: false,
      message:
        'scout_brief: not currently part of an active parallel fan-out pass.',
      error: 'no_active_scout_pass'
    }
  }
  const participantId = deps.getParticipantIdForRun(runId)
  if (!participantId) {
    return {
      ok: false,
      message: 'scout_brief: no orchestrator-tracked participant for this run id.',
      error: 'unknown_participant'
    }
  }
  const meta = deps.getParticipantMeta(runId)
  if (!meta) {
    return {
      ok: false,
      message: 'scout_brief: orchestrator does not have metadata for this participant.',
      error: 'unknown_participant'
    }
  }
  const findings = (args.findings || '').trim().slice(0, MAX_FINDINGS_LENGTH)
  if (!findings) {
    return {
      ok: false,
      message: 'scout_brief: `findings` is required and must be a non-empty string.',
      error: 'missing_findings'
    }
  }
  const confidence =
    args.confidence && VALID_CONFIDENCE.includes(args.confidence) ? args.confidence : null
  if (!confidence) {
    return {
      ok: false,
      message: `scout_brief: \`confidence\` must be one of 'high' | 'medium' | 'low'. Got: ${args.confidence}.`,
      error: 'invalid_confidence'
    }
  }
  const brief: ScoutBriefRecord = {
    participantId,
    participantRole: meta.role,
    provider: meta.provider,
    findings,
    confidence,
    emittedAt: new Date().toISOString(),
    ...(args.blockers ? { blockers: sanitiseStringList(args.blockers) } : {}),
    ...(args.recommendations ? { recommendations: sanitiseStringList(args.recommendations) } : {}),
    ...(args.tags ? { tags: sanitiseStringList(args.tags) } : {})
  }
  // Prune empty arrays for tidy storage.
  if (brief.blockers && brief.blockers.length === 0) delete brief.blockers
  if (brief.recommendations && brief.recommendations.length === 0) delete brief.recommendations
  if (brief.tags && brief.tags.length === 0) delete brief.tags

  deps.recordScoutBrief(runId, brief)
  return {
    ok: true,
    message: `Fan-out brief recorded · ${meta.role} (${meta.provider}) · confidence ${confidence}.`
  }
}

/**
 * Format a collection of fan-out briefs as a markdown-like context
 * block for the serial writer's prompt. Used by
 * `EnsemblePrompt.buildEnsembleParticipantPrompt` when the writer's
 * round has fan-out briefs available.
 *
 * Sample output:
 *   Fan-out briefs from the parallel pass:
 *     [Claude / Reviewer] (high) — Module X has 3 invariants ...
 *       Blockers:
 *         - shared mutable state in Y
 *       Recommendations:
 *         - lift the lock into Z
 *     [Gemini / Researcher] (medium) — External API expects shape ...
 */
export function formatScoutBriefsForPrompt(briefs: ScoutBriefRecord[]): string {
  if (briefs.length === 0) return ''
  const lines: string[] = ['Fan-out briefs from the parallel pass:']
  for (const brief of briefs) {
    lines.push(
      `  [${brief.participantRole} (${brief.provider})] (${brief.confidence}) — ${brief.findings}`
    )
    if (brief.blockers && brief.blockers.length > 0) {
      lines.push('    Blockers:')
      for (const blocker of brief.blockers) {
        lines.push(`      - ${blocker}`)
      }
    }
    if (brief.recommendations && brief.recommendations.length > 0) {
      lines.push('    Recommendations:')
      for (const rec of brief.recommendations) {
        lines.push(`      - ${rec}`)
      }
    }
    if (brief.tags && brief.tags.length > 0) {
      lines.push(`    Tags: ${brief.tags.join(', ')}`)
    }
  }
  return lines.join('\n')
}
