import { normalizeEnsembleMcpToolArguments } from '../../shared/taskWraithMcpCatalog'
import { resolveEnsembleGroupMentionToken } from '../../shared/ensembleGroupMention'
import {
  ENSEMBLE_FANOUT_SCOPE_REPAIR_GUIDANCE,
  ENSEMBLE_FANOUT_WRITE_SCOPES_GUIDANCE
} from '../../shared/ensembleFanoutWriteScopes'
import type { McpResultRepairHint } from './McpResultRepairHints'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function singleWriterTarget(targets: unknown): string | undefined {
  const values = typeof targets === 'string' ? [targets] : targets
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
    return undefined
  }
  const target = values[0].trim().replace(/^@+/, '')
  // A group is not a single writer, even when it occupies one array entry.
  if (!target || target === '*' || resolveEnsembleGroupMentionToken(target)) {
    return undefined
  }
  return target
}

/** Suggest a same-tool correction; never execute it or infer missing ownership. */
export function buildEnsembleFanoutScopeRepair(
  received: Record<string, unknown>,
  normalized: Record<string, unknown>,
  message?: string
): Omit<McpResultRepairHint, 'receivedKeys'> {
  const args = normalizeEnsembleMcpToolArguments('ensemble_fanout', {
    ...received,
    ...normalized
  }) as Record<string, unknown>
  const retryTemplate: Record<string, unknown> = { mode: 'locked_writers' }
  for (const key of ['targets', 'prompt', 'reason', 'isolation']) {
    if (args[key] !== undefined) retryTemplate[key] = args[key]
  }
  const targetStage = args.targetStage ?? args.stage
  if (targetStage !== undefined) retryTemplate.targetStage = targetStage

  let scopes = args.writeScopes ?? args.write_scopes
  if (typeof scopes === 'string' && scopes.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(scopes)
      if (Array.isArray(parsed)) scopes = parsed
    } catch {
      // Keep malformed JSON visible as an argument problem, never as a path.
    }
  }
  let requiresInput = true
  let correction: string
  if (isRecord(scopes) && Object.keys(scopes).length > 0) {
    // Retain ALL keys and paths, including a rejected alias. Only the live
    // roster can tell which participant that alias was supposed to identify.
    retryTemplate.writeScopes = scopes
    correction =
      'Keep the supplied scope map; correct the key or value identified by the error. Use the returned valid aliases or list_ensemble_participants to select the exact target ID.'
    if (
      typeof (received.writeScopes ?? received.write_scopes) === 'string' &&
      message?.includes('must be an object keyed by target alias')
    ) {
      correction = 'Send writeScopes as the decoded object in this template.'
      requiresInput = false
    }
  } else {
    const target = singleWriterTarget(args.targets)
    const paths =
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every((path) => typeof path === 'string' && path.trim() && !path.includes('\0'))
        ? scopes
        : typeof scopes === 'string' &&
            scopes.trim() &&
            !/^\s*[[{]/.test(scopes) &&
            !scopes.includes('\0')
          ? [scopes]
          : undefined
    retryTemplate.writeScopes = {
      [target || '<writer-participant-id>']: paths || ['<workspace-relative-path>']
    }
    requiresInput = !target || !paths
    correction = target
      ? 'Put the supplied paths under the single target key shown in the template.'
      : 'Choose the intended writer participant ID for each path; replace the placeholder key. A group or multiple targets does not identify one writer.'
    if (!paths) correction += ' Replace the path placeholder with the intended non-empty scope.'
  }
  return {
    why: [
      message,
      correction,
      ENSEMBLE_FANOUT_WRITE_SCOPES_GUIDANCE,
      ENSEMBLE_FANOUT_SCOPE_REPAIR_GUIDANCE
    ]
      .filter(Boolean)
      .join(' '),
    retryTemplate,
    requiresInput
  }
}
