import { resolveCanonicalToolName, resolveCatalogToolName } from './canonicalToolCoalesce'
import { resolveToolDispatchContractStrict } from './providerActionTaxonomy'
import type { ToolActivity } from '../main/store/types'

export type ToolInvocationParameters = Record<string, unknown>

export interface ToolInvocationPresentation {
  /** Canonical only when the reported name has a declared display alias. */
  toolName: string
  /** The concrete target arguments, including a capability gateway's inner bag. */
  parameters: ToolInvocationParameters
  /** True when `capability_invoke` was safely projected to its resolved target. */
  viaCapabilityGateway: boolean
}

const ARGUMENT_BAG_KEYS = [
  'arguments',
  'input',
  'args',
  'payload',
  'params',
  'toolInput',
  'tool_input',
  'rawInput',
  'parameters'
] as const

const RESULT_EVIDENCE_KEYS = [
  'additions',
  'added',
  'linesAdded',
  'lines_added',
  'insertions',
  'deletions',
  'deleted',
  'linesDeleted',
  'linesRemoved',
  'lines_removed',
  'removals',
  'changes',
  'patch',
  'diff',
  'diffString',
  'diff_string',
  'patchPreview',
  'patch_preview',
  'unifiedDiff',
  'unified_diff',
  'kind',
  'status'
] as const

const TRANSPORT_ONLY_KEYS = new Set([
  'type',
  'tool_name',
  'toolName',
  'tool_id',
  'toolId',
  'call_id',
  'tool_call_id',
  'toolCallId',
  'provider',
  'server',
  'namespace',
  'raw',
  'function'
])

const MCP_TRANSPORT_WRAPPER_NAMES = new Set(['callmcptool', 'call_mcp_tool', 'mcp', 'use_tool'])

const MCP_TRANSPORT_WRAPPER_DISPLAY_NAMES = new Set([
  'used callmcptool',
  'used call_mcp_tool',
  'used mcp',
  'mcp',
  'used an mcp tool'
])

const COMMAND_LIKE_ACTIVITY_KEYS = [
  'command',
  'cmd',
  'script',
  'bash',
  'shell',
  'shell_command',
  'shellCommand',
  'terminal_command',
  'terminalCommand'
] as const

const ACTIVITY_NESTED_RECORD_KEYS = [
  'parameters',
  'params',
  'payload',
  'args',
  'input',
  'arguments',
  'rawInput',
  'toolInput',
  'tool_input'
] as const

function recordFrom(value: unknown): ToolInvocationParameters | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ToolInvocationParameters
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ToolInvocationParameters)
      : undefined
  } catch {
    return undefined
  }
}

function firstStringField(
  record: ToolInvocationParameters,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function nestedActivityRecords(value: unknown): ToolInvocationParameters[] {
  const root = recordFrom(value)
  if (!root) return []
  const records = [root]
  for (const key of ACTIVITY_NESTED_RECORD_KEYS) {
    const nested = recordFrom(root[key])
    if (nested) records.push(nested)
  }
  return records
}

function activityPayloadRecords(activity: ToolActivity): ToolInvocationParameters[] {
  return [
    ...(activity.parameters ? [activity.parameters] : []),
    ...nestedActivityRecords(activity.rawUseEvent)
  ]
}

function hasCommandLikeActivityPayload(activity: ToolActivity): boolean {
  if (activity.category === 'shell') return true
  return activityPayloadRecords(activity).some((record) =>
    Boolean(firstStringField(record, COMMAND_LIKE_ACTIVITY_KEYS))
  )
}

function hasMcpTransportEvidence(activity: ToolActivity): boolean {
  return activityPayloadRecords(activity).some((record) => {
    const transportType = firstStringField(record, ['type', 'kind', 'tool_kind', 'toolKind'])
    if (transportType?.toLowerCase().includes('mcp')) return true
    if (
      firstStringField(record, [
        'server',
        'serverName',
        'server_name',
        'providerIdentifier',
        'provider_identifier',
        'mcpToolName',
        'mcp_tool_name',
        'mcpTool',
        'mcp_tool'
      ])
    ) {
      return true
    }
    const wrapper = firstStringField(record, ['tool', 'toolName', 'tool_name', 'name'])
    return wrapper ? MCP_TRANSPORT_WRAPPER_NAMES.has(wrapper.toLowerCase()) : false
  })
}

/**
 * Whether a stored activity is only a provider's MCP transport envelope.
 *
 * Grok and Cursor can emit these opaque discovery/pre-call wrappers alongside
 * the concrete tool activity. Keep the wrapper in the transcript/audit model,
 * but omit it from user-facing rows and derived tool-call counts. A
 * command-shaped activity is never hidden: several historical providers used
 * the same generic names for real shell work.
 */
export function isMcpTransportWrapperActivity(activity: ToolActivity): boolean {
  if (hasCommandLikeActivityPayload(activity)) return false
  const toolName = (activity.toolName || '').trim().toLowerCase()
  const displayName = (activity.displayName || '').trim().toLowerCase()
  if (MCP_TRANSPORT_WRAPPER_NAMES.has(toolName)) return true
  if (MCP_TRANSPORT_WRAPPER_DISPLAY_NAMES.has(displayName)) return true
  if (toolName === 'unknown' || displayName === 'used unknown' || displayName === 'unknown') {
    return hasMcpTransportEvidence(activity)
  }
  return false
}

function parameterRecord(value: unknown): ToolInvocationParameters {
  if (typeof value === 'string') {
    const parsed = recordFrom(value)
    // Native command wrappers legitimately use a source-string input rather
    // than JSON. Keep it displayable instead of silently dropping it.
    return parsed || { input: value }
  }
  return recordFrom(value) || {}
}

function hasMeaningfulOwnField(record: ToolInvocationParameters): boolean {
  return Object.keys(record).some(
    (key) =>
      record[key] !== undefined &&
      !TRANSPORT_ONLY_KEYS.has(key) &&
      !(ARGUMENT_BAG_KEYS as readonly string[]).includes(key)
  )
}

/**
 * Extract provider call arguments without treating an empty higher-priority
 * bag as an instruction to discard a populated lower-priority one. The
 * sidecar and legacy transcript lanes both use this, so argument shapes such
 * as OpenAI `function.arguments`, ACP `rawInput`, and Cursor `args` retain
 * their mutation evidence after dual-lane dedupe.
 */
export function extractToolInvocationParameters(payload: unknown): ToolInvocationParameters {
  const root = recordFrom(payload)
  if (!root) return {}

  const functionRecord = recordFrom(root.function)
  const bags = [
    ...ARGUMENT_BAG_KEYS.map((key) => parameterRecord(root[key])),
    parameterRecord(functionRecord?.arguments),
    parameterRecord(functionRecord?.args),
    parameterRecord(functionRecord?.input)
  ]
  const merged = Object.assign({}, ...bags)
  if (Object.keys(merged).length > 0) {
    // Some adapters put a transport envelope in `params` and the real input
    // one level deeper. Preserve a capability envelope (it has a meaningful
    // `name`) but unwrap a metadata-only shell.
    if (!hasMeaningfulOwnField(merged)) {
      for (const key of ARGUMENT_BAG_KEYS) {
        const nested = parameterRecord(merged[key])
        if (Object.keys(nested).length > 0) return nested
      }
    }
    return merged
  }

  return hasMeaningfulOwnField(root) ? { ...root } : {}
}

function collectResultEvidence(value: unknown, depth = 0): ToolInvocationParameters {
  if (depth > 3) return {}
  const record = recordFrom(value)
  if (!record) return {}
  const evidence: ToolInvocationParameters = {}
  for (const key of RESULT_EVIDENCE_KEYS) {
    if (record[key] !== undefined) evidence[key] = record[key]
  }
  for (const key of ['result', 'data', 'payload', 'output'] as const) {
    Object.assign(evidence, collectResultEvidence(record[key], depth + 1))
  }
  return evidence
}

/**
 * Free-text output carriers a terminal result reports — the same fields the
 * `extractResultOutput`-style readers treat as the tool's output, which the
 * transcript already keeps as the (capped) result summary. When the call has
 * its own input arguments these are echo, not arguments: folding them into
 * the presented parameters persisted a read's whole file body under
 * `parameters.content` (tens of KB per row) and handed the diff estimators
 * output text to count as an edit.
 */
const RESULT_OUTPUT_TEXT_KEYS = new Set([
  'content',
  'contents',
  'output',
  'result',
  'stdout',
  'stderr',
  'summary',
  'message',
  'text'
])

function omitResultOutputText(parameters: ToolInvocationParameters): ToolInvocationParameters {
  const scrubbed: ToolInvocationParameters = {}
  for (const key of Object.keys(parameters)) {
    if (RESULT_OUTPUT_TEXT_KEYS.has(key)) continue
    scrubbed[key] = parameters[key]
  }
  return scrubbed
}

/**
 * Keep input arguments as the display baseline while allowing a terminal
 * result to contribute the only fields it can authoritatively know: measured
 * line counts, `changes`, and patch evidence. This prevents a tool-result
 * `content` preview from replacing the original write body while still
 * letting result-only providers light the same `+N -N` row.
 *
 * A call WITH input keeps only the result's non-output fields (paths, ids,
 * evidence) — its output echo already lives in the result summary, never in
 * the persisted parameters. A call WITHOUT input (result-only providers put
 * the tool INPUT on the result event) keeps the whole result root, byte for
 * byte the old behaviour, because the root is then the only argument source
 * — a content-only write must still light its `+N -0` row from it.
 */
export function mergeToolResultParameters(
  input: ToolInvocationParameters | undefined,
  resultPayload: unknown
): ToolInvocationParameters {
  const resultParameters = extractToolInvocationParameters(resultPayload)
  const hasInput = Boolean(input && Object.keys(input).length > 0)
  return {
    ...(hasInput ? omitResultOutputText(resultParameters) : resultParameters),
    ...(input || {}),
    ...collectResultEvidence(resultParameters),
    ...collectResultEvidence(resultPayload)
  }
}

function capabilityTargetParameters(
  parameters: ToolInvocationParameters
): ToolInvocationParameters {
  for (const key of [
    'rawInput',
    'input',
    'parameters',
    'arguments',
    'args',
    'toolInput',
    'tool_input'
  ] as const) {
    const candidate = parameterRecord(parameters[key])
    if (Object.keys(candidate).length > 0) return extractToolInvocationParameters(candidate)
  }
  return {}
}

/**
 * Presentation-only projection of a declared TaskWraith gateway envelope.
 * Dispatch still performs its own strict resolution; this merely makes a
 * successful `capability_invoke({ name: 'replace', arguments: ... })` look
 * like the same concrete replacement in every transcript lane. Invalid or
 * conflicting envelopes deliberately remain visible as their outer call.
 */
export function presentToolInvocation(
  rawToolName: string,
  rawParameters: ToolInvocationParameters | undefined
): ToolInvocationPresentation {
  const parameters = rawParameters || {}
  const canonical = resolveCanonicalToolName(rawToolName)
  const contract = resolveToolDispatchContractStrict(
    canonical === 'capability_invoke' ? canonical : rawToolName,
    parameters
  )
  if (!contract.ok || contract.resolution !== 'target-derived') {
    return { toolName: rawToolName, parameters, viaCapabilityGateway: false }
  }

  return {
    toolName: contract.effectiveToolName,
    parameters: capabilityTargetParameters(parameters),
    viaCapabilityGateway: true
  }
}

/** Resolve a display alias while retaining an unknown/free-form human title. */
export function canonicalPresentationToolName(rawToolName: string): string {
  return resolveCatalogToolName(rawToolName) || resolveCanonicalToolName(rawToolName) || rawToolName
}
