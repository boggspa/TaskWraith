import { MAX_ENSEMBLE_PARTICIPANTS } from '../../shared/ensembleLimits'
import { ENSEMBLE_WRITER_GIT_GUIDANCE, providerLabel } from '../EnsemblePrompt'
import type { ConcurrentLaneWriteScope, EnsembleParticipant, ProviderId } from '../store/types'
import {
  isPlainRecord,
  isVagueUserPreflightScope,
  normalizeConcurrentWriteScopes
} from './EnsembleWriteScopePaths'

/**
 * Write-scope claim, ack, and prompt helpers extracted from EnsembleOrchestrator.
 * Canonical ActiveParticipantRun and ConcurrentWriteScopeClaim types remain in
 * the monolith. This module accepts structural run/claim shapes so it does not
 * import the 23k-line orchestrator (avoids a runtime/type cycle). No admission,
 * overlap/path, or capability-policy change.
 */

/** Structural run subset of ActiveParticipantRun used by claim/ack parsers. */
export type WriteScopeClaimRun = {
  content?: string
  participant: Pick<EnsembleParticipant, 'id' | 'role' | 'provider'>
}

/** Structural match for ConcurrentWriteScopeClaim in EnsembleOrchestrator. */
type ConcurrentWriteScopeClaim = {
  participantId: string
  participantRole: string
  provider: ProviderId
  scopes: ConcurrentLaneWriteScope[]
  operations: string[]
  rationale?: string
  canFallbackToSerial: boolean
}

export function stripLeadingAt(value: string): string {
  return value.trim().replace(/^@+/, '').trim()
}

export function isUserYieldTarget(value: string | undefined): boolean {
  const target = stripLeadingAt(value || '').toLowerCase()
  return target === 'user' || target === 'human' || target === 'you'
}

export function normalizeTargetList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_ENSEMBLE_PARTICIPANTS)
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

export function isBroadFanoutRequest(value: unknown): boolean {
  const targets = normalizeTargetList(value)
  return targets.length === 0 || targets.some((target) => /^@?all$/i.test(target))
}

export function dedupeParticipants(participants: EnsembleParticipant[]): EnsembleParticipant[] {
  const seen = new Set<string>()
  const out: EnsembleParticipant[] = []
  for (const participant of participants) {
    if (!participant?.id || seen.has(participant.id)) continue
    seen.add(participant.id)
    out.push(participant)
  }
  return out
}

export function pickRawWriteScopesForParticipant(
  rawScopes: unknown,
  participant: EnsembleParticipant
): unknown {
  if (Array.isArray(rawScopes) || typeof rawScopes === 'string') return rawScopes
  if (!isPlainRecord(rawScopes)) return undefined
  const keys = [
    participant.id,
    participant.role,
    participant.provider,
    providerLabel(participant.provider),
    '*',
    'all'
  ]
    .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    .map((key) => key.toLowerCase())
  for (const [key, value] of Object.entries(rawScopes)) {
    if (keys.includes(stripLeadingAt(key).toLowerCase())) return value
  }
  return undefined
}

export function extractJsonFromContent(content: string, marker: string): unknown {
  const fencePattern = /```([A-Za-z0-9_-]*)\s*([\s\S]*?)```/g
  for (const match of content.matchAll(fencePattern)) {
    const language = (match[1] || '').trim().toLowerCase()
    if (language && language !== 'json' && language !== marker.toLowerCase()) continue
    try {
      return JSON.parse((match[2] || '').trim())
    } catch {
      // Try the next fenced block.
    }
  }
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1))
    } catch {
      return null
    }
  }
  return null
}

export function sanitizedStringList(value: unknown, maxItems = 12, maxLength = 80): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLength))
}

export function rawClaimScopes(raw: Record<string, unknown>): unknown {
  return raw.writeScopes ?? raw.write_scopes ?? raw.scopes ?? raw.paths ?? raw.globs
}

export function parseConcurrentWriteScopeClaim(
  run: WriteScopeClaimRun,
  approvedAt: string
): { ok: true; claim: ConcurrentWriteScopeClaim } | { ok: false; reason: string } {
  const rawJson = extractJsonFromContent(run.content || '', 'taskwraith_write_claim')
  if (!isPlainRecord(rawJson)) {
    return {
      ok: false,
      reason: `${
        run.participant.role || providerLabel(run.participant.provider)
      } did not return a valid taskwraith_write_claim JSON object.`
    }
  }
  const scopes = normalizeConcurrentWriteScopes(
    rawClaimScopes(rawJson),
    'user-preflight',
    approvedAt
  )
  if (scopes.length === 0) {
    return {
      ok: false,
      reason: `${
        run.participant.role || providerLabel(run.participant.provider)
      } did not claim any concrete write scopes.`
    }
  }
  if (scopes.some(isVagueUserPreflightScope)) {
    return {
      ok: false,
      reason: `${
        run.participant.role || providerLabel(run.participant.provider)
      } claimed a vague or workspace-wide write scope.`
    }
  }
  const ack =
    rawJson.acknowledgeExclusiveScope === true ||
    rawJson.acknowledge_scope_matrix === true ||
    rawJson.acknowledgeScopeMatrix === true ||
    rawJson.ack === true
  if (!ack) {
    return {
      ok: false,
      reason: `${
        run.participant.role || providerLabel(run.participant.provider)
      } did not acknowledge the exclusive write-scope contract.`
    }
  }
  const fallback =
    rawJson.canFallbackToSerial === true ||
    rawJson.can_fallback_to_serial === true ||
    rawJson.fallbackSerial === true
  if (!fallback) {
    return {
      ok: false,
      reason: `${
        run.participant.role || providerLabel(run.participant.provider)
      } did not confirm it can fall back to serial execution.`
    }
  }
  const rationale =
    typeof rawJson.rationale === 'string' && rawJson.rationale.trim()
      ? rawJson.rationale.trim().slice(0, 500)
      : undefined
  return {
    ok: true,
    claim: {
      participantId: run.participant.id,
      participantRole: run.participant.role || providerLabel(run.participant.provider),
      provider: run.participant.provider,
      scopes,
      operations: sanitizedStringList(
        rawJson.operations ?? rawJson.operationTypes ?? rawJson.operation_types
      ),
      canFallbackToSerial: true,
      ...(rationale ? { rationale } : {})
    }
  }
}

export function parseConcurrentWriteScopeAck(run: WriteScopeClaimRun): boolean {
  const rawJson = extractJsonFromContent(run.content || '', 'taskwraith_write_ack')
  if (!isPlainRecord(rawJson)) return false
  return (
    rawJson.acknowledgeMatrix === true ||
    rawJson.acknowledge_matrix === true ||
    rawJson.acknowledgeScopeMatrix === true ||
    rawJson.ack === true
  )
}

export function writeScopeClaimPrompt(): string {
  return [
    'Read-only write-scope preflight. Do not edit files, run shell commands, stage, or commit.',
    'Return a single JSON object in a fenced block tagged taskwraith_write_claim.',
    'The JSON schema is:',
    '{',
    '  "writeScopes": ["workspace-relative/path/or/glob/**"],',
    '  "operations": ["edit" | "create" | "delete" | "rename"],',
    '  "rationale": "why this lane owns only these files",',
    '  "canFallbackToSerial": true,',
    '  "acknowledgeExclusiveScope": true',
    '}',
    'Scopes must be concrete, workspace-relative, and non-overlapping with other writers. Do not claim workspace, ".", "*", "**", or external paths. If you cannot name a narrow scope, return an empty writeScopes array and canFallbackToSerial true.'
  ].join('\n')
}

export function writeScopeAckPrompt(matrixSummary: string): string {
  return [
    'Read-only write-scope matrix acknowledgment. Do not edit files, run shell commands, stage, or commit.',
    'The host built this non-overlap matrix:',
    matrixSummary,
    'Return a single JSON object in a fenced block tagged taskwraith_write_ack:',
    '{ "acknowledgeMatrix": true }',
    'Only acknowledge if your lane can stay within its listed scope.'
  ].join('\n')
}

export function writeScopeExecutionPrompt(matrixSummary: string): string {
  return [
    'Locked writer fan-out is authorized by user preflight.',
    'Stay strictly within your approved write scope. If you need to write outside scope, stop and report the required serial follow-up.',
    ENSEMBLE_WRITER_GIT_GUIDANCE,
    'Approved scope matrix:',
    matrixSummary
  ].join('\n')
}
