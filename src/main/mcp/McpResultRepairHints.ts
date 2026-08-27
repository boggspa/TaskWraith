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
 * Blackboard post fields, rebuilt from the caller's own arguments with the
 * offending field swapped for a placeholder. Blackboard calls carry no params
 * envelope, so normalized and received are usually the same object.
 */
function blackboardPostRetryTemplate(
  received: Record<string, unknown>,
  normalized: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    key: stringValue(firstDefined(normalized, received, ['key'])) || '<key>',
    value: stringValue(firstDefined(normalized, received, ['value'])) || '<value>'
  }
  const category = firstDefined(normalized, received, ['category'])
  const scope = firstDefined(normalized, received, ['scope'])
  const ttl = firstDefined(normalized, received, ['ttlMinutes', 'ttl_minutes'])
  if (category !== undefined) template.category = category
  if (scope !== undefined) template.scope = scope
  if (ttl !== undefined) template.ttlMinutes = ttl
  return { ...template, ...overrides }
}

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
 * Blackboard failures are dispatched here keyed on their `code` field (or the
 * exact self-namespaced error string for the code-less ones) — the blackboard
 * field-error payloads carry `code`/`maxLength`/`originalLength` and no
 * `error` text at all, so a tool-name key could not read them. The dispatch
 * guard's repair-entry regex scans for `input.toolName ===` literals, which
 * code-keyed branches intentionally do not use; a guard that derives the
 * wrapped set from actual wrapper usage should also learn to see code-keyed
 * entries.
 *
 * Blackboard coverage boundary: repairs attach to CALLER-CORRECTABLE input
 * failures — capacity exhaustion, key/value length caps, poll option shape,
 * ttlMinutes range, missing key/value, a delete selector that matched nothing,
 * and a round-scoped post with no active round. Environment/host states stay
 * verdicts on purpose: a non-Ensemble chat, image-ingest failures, and
 * finalization failures cannot be fixed by changing the call, so a corrected
 * template would be a lie.
 *
 * The S5 builders above cover NON-ensemble tools (capability_invoke,
 * apply_patch) and are deliberately not dispatched yet: the M6 dispatch guard
 * (McpGatewayMainDispatchContract.test.ts) ties every dispatched tool-keyed
 * repair entry to an mcpEnsembleJson-wrapped branch, and wrapping those two
 * tools' index.ts result paths belongs to the pass that owns index.ts,
 * together with the guard evolution that discovers wrapped branches instead
 * of hardcoding the ensemble set. The builders are exported and unit-tested
 * so that pass adds one branch per tool and nothing else.
 */
export function attachMcpResultRepairHints(input: McpResultRepairHintInput): unknown {
  if (!isRecord(input.result) || input.result.ok !== false) return input.result

  const received = isRecord(input.receivedArguments) ? input.receivedArguments : {}
  const normalized = isRecord(input.normalizedArguments) ? input.normalizedArguments : received
  const error = stringValue(input.result.error)
  const code = stringValue(input.result.code)
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
  } else if (code === 'blackboard_capacity_exhausted') {
    // The board-bricking one: session/chat entries are never evicted, so a
    // full board rejects every seat's posts. The escapes are real calls, not
    // prose — upsert a key you already hold, read and retire stale entries,
    // or post with a TTL so the entry retires itself.
    repair = {
      why: 'The board is capped and session/chat entries never auto-evict. Re-posting under a key you already hold upserts in place (no new slot); otherwise blackboard_read the board, retire stale entries with blackboard_delete, or post with ttlMinutes so the entry retires itself.',
      receivedKeys: receivedKeys(received),
      retryTemplate: { tool: 'blackboard_read', arguments: { last: 60 } }
    }
  } else if (code === 'blackboard_key_too_long' || code === 'blackboard_value_too_long') {
    const field = code === 'blackboard_key_too_long' ? 'key' : 'value'
    const maxLength =
      typeof input.result.maxLength === 'number' ? input.result.maxLength : undefined
    const originalLength =
      typeof input.result.originalLength === 'number' ? input.result.originalLength : undefined
    repair = {
      why: `${field} is ${originalLength ?? 'over'}-long against a ${maxLength ?? 'fixed'}-char cap. Shorten the ${field}: keys name an entry, and long-form content belongs in the value (readable in full via blackboard_read).`,
      receivedKeys: receivedKeys(received),
      retryTemplate: blackboardPostRetryTemplate(received, normalized, {
        [field]: `<${field} ≤ ${maxLength ?? 'cap'} chars>`
      })
    }
  } else if (
    code === 'blackboard_poll_options_invalid' ||
    code === 'blackboard_poll_option_too_long' ||
    code === 'blackboard_poll_options_duplicate'
  ) {
    const minItems = typeof input.result.minItems === 'number' ? input.result.minItems : 2
    const maxItems = typeof input.result.maxItems === 'number' ? input.result.maxItems : 6
    const maxLength =
      typeof input.result.maxLength === 'number' ? input.result.maxLength : undefined
    const why =
      code === 'blackboard_poll_options_duplicate'
        ? 'pollOptions choices must be unique after trimming and whitespace folding — two options that render the same are one choice.'
        : code === 'blackboard_poll_option_too_long'
          ? `Each pollOptions choice is capped at ${maxLength ?? 160} chars. Move the detail into the value and keep choices short.`
          : `pollOptions must contain ${minItems}–${maxItems} plain-text choices.`
    repair = {
      why,
      receivedKeys: receivedKeys(received),
      retryTemplate: blackboardPostRetryTemplate(received, normalized, {
        pollOptions: ['<choice 1>', '<choice 2>']
      })
    }
  } else if (error === 'blackboard_post requires non-empty key and value.') {
    repair = {
      why: 'key and value are both required and must be non-empty after trimming.',
      receivedKeys: receivedKeys(received),
      retryTemplate: blackboardPostRetryTemplate(received, normalized, {})
    }
  } else if (code === 'blackboard_ttl_invalid') {
    repair = {
      why: 'ttlMinutes must be an integer from 1 to 10080. Omit it for the 24-hour default, or pass null for an entry that never expires.',
      receivedKeys: receivedKeys(received),
      retryTemplate: blackboardPostRetryTemplate(received, normalized, {
        ttlMinutes: '<integer 1–10080>'
      })
    }
  } else if (
    error?.startsWith('Round-scoped blackboard entries require an active Ensemble round.')
  ) {
    // Caller-correctable: the message itself advises the durable scopes, so
    // hand back the same post as the session-scoped call it recommends.
    repair = {
      why: 'No Ensemble round is active, and round-scoped entries need one. Retry with scope "session" for the same durable note, or re-post when the next round opens.',
      receivedKeys: receivedKeys(received),
      retryTemplate: blackboardPostRetryTemplate(received, normalized, { scope: 'session' })
    }
  } else if (
    error === 'No blackboard entries matched. Pass ids, keys, category, or all:true to delete.'
  ) {
    repair = {
      why: 'The selector matched nothing — entries may be round-scoped to an ended round or already retired. Read the board first and delete by an id or key that exists.',
      receivedKeys: receivedKeys(received),
      retryTemplate: { tool: 'blackboard_read', arguments: {} }
    }
  }

  return repair ? { ...input.result, repair } : input.result
}
