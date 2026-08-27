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

/**
 * Enrich only known ensemble failures at the main-process result boundary.
 * The caller's original argument keys remain visible, while a normalized
 * copy supplies values that arrived inside an envelope or snake_case alias.
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
