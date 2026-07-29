import { resolveToolDispatchContractStrict } from '../shared/providerActionTaxonomy'
import type { RunQueueJobSource } from './store/types'

const USER_INITIATED_RUN_SOURCES = new Set<RunQueueJobSource>(['manual', 'remote'])

const ENSEMBLE_TARGET = /\b(?:ensemble(?:\s+(?:chat|panel))?|roster(?:\s+preset)?)\b/i
const CREATION_ACTION =
  /\b(?:create|make|build|assemble|configure|generate|form|start|activate|import|apply)\b|\bset\s*up\b/i
const TURN_INTO_ENSEMBLE = /\bturn\b[^.!?\n]{0,80}\binto\b[^.!?\n]{0,40}\bensemble\b/i
const NEGATED_CREATION =
  /\b(?:do\s+not|don't|dont|never|avoid|without)\b[^.!?\n]{0,40}(?:\b(?:create|make|build|assemble|configure|generate|form|start|activate|import|apply)\b|\bset\s*up\b)/i
const INFORMATIONAL_REQUEST =
  /\b(?:tell\s+me\s+how|show\s+me\s+how|how\s+(?:can|could|do|would)\s+i)\b|\b(?:explain|describe|document|discuss|review)\b[^.!?\n]{0,32}\b(?:ensemble|panel|roster)\b/i
const SELF_CAPABILITY_QUESTION = /^\s*(?:can|could|may|should)\s+i\b/i

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Conservative text classifier for the narrow approval exception. It accepts
 * direct requests to create/import/activate an Ensemble panel and rejects
 * documentation questions, self-capability questions, and negated requests.
 */
export function userPromptExplicitlyRequestsEnsembleCreation(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false
  const text = prompt.trim()
  if (!text || INFORMATIONAL_REQUEST.test(text) || SELF_CAPABILITY_QUESTION.test(text)) return false

  for (const clause of text.split(/[.!?\n]+/)) {
    if (!ENSEMBLE_TARGET.test(clause)) continue
    if (NEGATED_CREATION.test(clause)) continue
    if (TURN_INTO_ENSEMBLE.test(clause)) return true
    if (CREATION_ACTION.test(clause)) return true
  }
  return false
}

export interface UserRequestedEnsembleImportInput {
  toolName: unknown
  toolArgs: unknown
  readOnly?: boolean
  runSource?: RunQueueJobSource
  prompt?: unknown
}

/**
 * Request-scoped exception for Ensemble creation. This deliberately does not
 * add ensemble_roster_edit to the global auto-allow set: all live roster edits
 * remain gated, and imports still fail closed for read-only or non-user runs.
 */
export function shouldAutoAllowUserRequestedEnsembleImport(
  input: UserRequestedEnsembleImportInput
): boolean {
  if (typeof input.toolName !== 'string') return false
  const contract = resolveToolDispatchContractStrict(input.toolName, input.toolArgs)
  if (!contract.ok || contract.effectiveToolName !== 'ensemble_roster_edit') return false
  const args = plainRecord(input.toolArgs)
  if (!args || args.action !== 'import_preset') return false
  if (input.readOnly === true) return false
  if (!input.runSource || !USER_INITIATED_RUN_SOURCES.has(input.runSource)) return false
  return userPromptExplicitlyRequestsEnsembleCreation(input.prompt)
}
