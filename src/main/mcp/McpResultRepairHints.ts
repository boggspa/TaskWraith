import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'

export interface McpResultRepairHint {
  why: string
  receivedKeys: string[]
  retryTemplate: Record<string, unknown>
}

export interface McpResultRepairHintInput {
  toolName: string
  receivedArguments: unknown
  normalizedArguments?: unknown
  result: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstDefined(
  normalized: Record<string, unknown>,
  received: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (normalized[key] !== undefined) return normalized[key]
    if (received[key] !== undefined) return received[key]
  }
  return undefined
}

function receivedKeys(record: Record<string, unknown>): string[] {
  const keys = Object.keys(record)
  if (isRecord(record.params)) {
    keys.push(...Object.keys(record.params).map((key) => `params.${key}`))
  }
  return [...new Set(keys)].sort()
}

function planRetryTemplate(
  received: Record<string, unknown>,
  normalized: Record<string, unknown>
): Record<string, unknown> {
  const planSummary =
    stringValue(firstDefined(normalized, received, ['planSummary', 'plan', 'summary', 'steps'])) ||
    '<plan>'
  if (isRecord(received.params)) {
    return { action: 'set_round_plan', params: { planSummary } }
  }
  return { action: 'set_round_plan', planSummary }
}

function writerTargetKey(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().replace(/^@+/, '')
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())
    )
    if (first) return first.trim().replace(/^@+/, '')
  }
  return '<writer-target>'
}

function fanoutRetryTemplate(
  received: Record<string, unknown>,
  normalized: Record<string, unknown>
): Record<string, unknown> {
  const targets = firstDefined(normalized, received, ['targets'])
  const prompt = firstDefined(normalized, received, ['prompt'])
  const reason = firstDefined(normalized, received, ['reason'])
  const targetStage = firstDefined(normalized, received, ['targetStage', 'target_stage', 'stage'])
  return {
    ...(targets !== undefined ? { targets } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(targetStage !== undefined ? { targetStage } : {}),
    mode: 'locked_writers',
    writeScopes: { [writerTargetKey(targets)]: ['<workspace-relative-path>'] }
  }
}

function scoutBriefRetryTemplate(
  received: Record<string, unknown>,
  normalized: Record<string, unknown>
): Record<string, unknown> {
  const rawConfidence = stringValue(firstDefined(normalized, received, ['confidence']))
  // Repair templates must themselves validate when replayed. Use the neutral
  // enum when no valid prefix can be recovered from the caller's value.
  const confidence =
    /^(high|medium|low)\b/i.exec(rawConfidence || '')?.[1]?.toLowerCase() || 'medium'
  const findings = firstDefined(normalized, received, ['findings'])
  return {
    ...(findings !== undefined ? { findings } : {}),
    confidence
  }
}

const DIRECT_TASKWRAITH_TOOL_NAMES: ReadonlySet<string> = new Set(TASKWRAITH_MCP_TOOLS)

/**
 * S5: capability_invoke unknown_target. The gateway's searchable set is
 * deliberately full-minus-direct, so a DIRECT tool name resolves to
 * unknown_target — a verdict that never tells the caller their tool was one
 * hop away. When the requested name is a real catalog tool, hand back the
 * direct call built from the caller's own arguments; otherwise route them to
 * capability_search. Unlike the ensemble templates, the corrected call lives
 * on a DIFFERENT tool, so the template names it explicitly.
 */
export function buildCapabilityInvokeUnknownTargetHint(
  input: McpResultRepairHintInput
): McpResultRepairHint | undefined {
  if (!isRecord(input.result) || input.result.ok !== false) return undefined
  const code = stringValue(input.result.code)
  const error = stringValue(input.result.error)
  if (code !== 'unknown_target' && !/^Unknown TaskWraith capability:/.test(error || '')) {
    return undefined
  }
  const received = isRecord(input.receivedArguments) ? input.receivedArguments : {}
  const normalized = isRecord(input.normalizedArguments) ? input.normalizedArguments : received
  const name = stringValue(firstDefined(normalized, received, ['name']))
  const targetArguments = firstDefined(normalized, received, ['arguments'])
  if (name && DIRECT_TASKWRAITH_TOOL_NAMES.has(name)) {
    return {
      why: `${name} is advertised directly — call it directly with the same arguments, not through capability_invoke. capability_invoke only reaches hidden capabilities; use capability_search to discover those.`,
      receivedKeys: receivedKeys(received),
      retryTemplate: { tool: name, arguments: isRecord(targetArguments) ? targetArguments : {} }
    }
  }
  return {
    why: 'No capability with that exact name is reachable through capability_invoke. capability_invoke only reaches hidden capabilities — run capability_search with what you mean and invoke the exact name it returns.',
    receivedKeys: receivedKeys(received),
    retryTemplate: { tool: 'capability_search', arguments: { query: name || '<capability>' } }
  }
}

/**
 * S5: apply_patch failures. The two failure modes that burned turns this
 * round are teachable even before the throw sites report hunk indices: hunk
 * headers must declare counts matching their body exactly, and context lines
 * carry a mandatory leading space; Codex "*** Begin Patch" envelopes are not
 * unified diffs at all. The caller's own patch is handed back because the fix
 * lives INSIDE the patch text. The hunk-index/declared-vs-actual enrichment
 * belongs to the throw sites (VerifiedWorkspaceMutationHandoff.ts,
 * WorkspaceToolExecutors.ts) and is tracked as owed work in the lane report.
 */
export function buildApplyPatchFailureHint(
  input: McpResultRepairHintInput
): McpResultRepairHint | undefined {
  if (!isRecord(input.result) || input.result.ok !== false) return undefined
  const message = stringValue(input.result.message) ?? stringValue(input.result.error)
  if (!message || !/patch/i.test(message)) return undefined
  const received = isRecord(input.receivedArguments) ? input.receivedArguments : {}
  const normalized = isRecord(input.normalizedArguments) ? input.normalizedArguments : received
  const patch = firstDefined(normalized, received, ['patch', 'diff'])
  const codexEnvelope = /Begin Patch/.test(message)
  const why = codexEnvelope
    ? 'apply_patch accepts only a real git unified diff. Convert the "*** Begin Patch" envelope: emit diff --git a/<path> b/<path> headers, --- a/<path> / +++ b/<path> markers, and @@ -old,count +new,count @@ hunks with one leading space on context lines.'
    : 'Patch failed its hunk audit. Each @@ -old,count +new,count @@ header must declare exactly the body line counts that follow, and every context line needs its mandatory leading space — a visually identical line without it does not apply. Recount from the failing hunk header outward.'
  return {
    why,
    receivedKeys: receivedKeys(received),
    retryTemplate: {
      patch: typeof patch === 'string' && patch.trim() ? patch : '<git unified diff>'
    }
  }
}

/**
 * Enrich only known ensemble failures at the main-process result boundary.
 * The caller's original argument keys remain visible, while a normalized
 * copy supplies values that arrived inside an envelope or snake_case alias.
 *
 * S5 builders below cover NON-ensemble tools (capability_invoke, apply_patch).
 * They are deliberately not dispatched from attachMcpResultRepairHints yet:
 * the M6 dispatch guard (McpGatewayMainDispatchContract.test.ts) ties every
 * dispatched repair entry to an mcpEnsembleJson-wrapped branch, and wrapping
 * those two tools' index.ts result paths belongs to the blackboard-coverage
 * pass, together with the guard evolution that discovers wrapped branches
 * instead of hardcoding the ensemble set. The builders are exported and
 * unit-tested now so that pass adds one branch per tool and nothing else.
 */
export function attachMcpResultRepairHints(input: McpResultRepairHintInput): unknown {
  if (!isRecord(input.result) || input.result.ok !== false) return input.result

  const received = isRecord(input.receivedArguments) ? input.receivedArguments : {}
  const normalized = isRecord(input.normalizedArguments) ? input.normalizedArguments : received
  const error = stringValue(input.result.error)
  const action = stringValue(firstDefined(normalized, received, ['action']))
  let repair: McpResultRepairHint | undefined

  if (
    (input.toolName === 'ensemble_control' || input.toolName === 'ensemble_bossman_control') &&
    action === 'set_round_plan' &&
    error === 'missing_required_field'
  ) {
    repair = {
      why: 'set_round_plan needs planSummary (or plan, summary, or steps).',
      receivedKeys: receivedKeys(received),
      retryTemplate: planRetryTemplate(received, normalized)
    }
  } else if (
    input.toolName === 'ensemble_fanout' &&
    (error === 'missing_write_scope' || error === 'invalid_write_scope')
  ) {
    repair = {
      why: 'In locked_writers mode, writeScopes keys grant write intent. Omit a target key to dispatch it read-only.',
      receivedKeys: receivedKeys(received),
      retryTemplate: fanoutRetryTemplate(received, normalized)
    }
  } else if (input.toolName === 'scout_brief' && error === 'invalid_confidence') {
    repair = {
      why: 'confidence must be exactly one of high, medium, or low with no prose suffix.',
      receivedKeys: receivedKeys(received),
      retryTemplate: scoutBriefRetryTemplate(received, normalized)
    }
  }

  return repair ? { ...input.result, repair } : input.result
}
