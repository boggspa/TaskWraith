import { createHash } from 'node:crypto'
import type { TaskWraithMcpToolDefinition } from '../McpToolCatalog'
import { isReadOnlyShellCommand } from '../grok/GrokReadOnlyShell'
import type { AgentApprovalAction } from '../store/types'
import {
  canonicalTaskWraithToolName,
  isPortableEnsembleControlToolName,
  normalizePortableEnsembleControlArguments,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'
import { isTaskWraithMcpToolName, mcpJson } from './McpResultHelpers'
import { validateGatewayToolArguments, type GatewayArgumentValidationIssue } from './McpToolGateway'
import type {
  PermissionOpportunityReleaseResult,
  PermissionOpportunityTakeResult,
  PermissionOpportunityValidatedRequest
} from './PermissionOpportunityRegistry'
import { isPermissionOpportunityBoundaryCode } from './PermissionOpportunityRegistry'

export const TOOL_PERMISSION_RETRY_TOOL_NAME =
  'request_tool_permission' as const satisfies TaskWraithMcpToolName

const MAX_FAILURE_LENGTH = 4000
const MAX_RATIONALE_LENGTH = 600
const MAX_ARGUMENT_BYTES = 64 * 1024

const UNPROVABLE_MUTATION_SCOPE_PATTERN =
  /\bcannot prove an exact (?:file\/hunk )?mutation scope\b/i

/**
 * Tools whose effects are an opaque OS process rather than a declarable edit
 * set. Caller-declared paths can never prove their mutation scope, so refusing
 * them an approval mirror is a dead end rather than a safety boundary: the seat
 * is told "use exact file tools" for work that no file tool can do.
 *
 * Both members carry the same `shellCommands` agentic service in the taxonomy,
 * so a run whose resolved policy already authorizes shell has, by construction,
 * authorized these too. They still differ in containment — see
 * `buildToolPermissionRetryApprovalPrompt` — and this exemption covers ONLY the
 * unprovable-scope failure. A lane FILE-scope denial stays non-retriable.
 */
const UNSCOPED_PROCESS_AUTHORITY_TOOLS = new Set<TaskWraithMcpToolName>([
  'run_shell_command',
  'start_background_process'
])

export function isUnscopedProcessAuthorityTool(toolName: TaskWraithMcpToolName): boolean {
  return UNSCOPED_PROCESS_AUTHORITY_TOOLS.has(toolName)
}

const NON_RETRIABLE_ENSEMBLE_LANE_PATTERNS = [
  /\b(?:lane|participant)\b.{0,160}\bnot approved to write\b/i,
  /\boutside the approved lane scope\b/i,
  /\bnot a writer lane\b/i,
  /\bno approved write scope\b/i,
  /\bpath-scoped writer lane\b/i,
  /\bparallel writer lanes?\b/i,
  /\bensemble participant run is no longer active\b/i
]

const NON_RETRIABLE_TARGETS = new Set<TaskWraithMcpToolName>([
  TOOL_PERMISSION_RETRY_TOOL_NAME,
  'ask_user_question',
  'delegate_to_subthread',
  'thread_message',
  'canvas_eval',
  'theme_tokens_set',
  'image_generate',
  'outlook_list_messages',
  'outlook_search_messages',
  'outlook_get_message',
  'outlook_list_events',
  'outlook_create_draft',
  'outlook_create_event',
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events'
])

const EXPLICIT_USER_DECLINE_PATTERNS = [
  /\buser\s+(?:explicitly\s+)?(?:declined|denied|rejected|cancelled|canceled|dismissed)\b/i,
  /\b(?:declined|denied|rejected|cancelled|canceled|dismissed)\s+by\s+(?:the\s+)?user\b/i,
  /\buser rejected (?:the )?mcp tool call\b/i
]

const PERMISSION_BOUNDARY_PATTERNS = [
  /\bpermission denied\b/i,
  /\boperation not permitted\b/i,
  /\b(?:eacces|eperm)\b/i,
  /\bread[- ]only file system\b/i,
  /\bsandbox(?:ed|ing)?\b/i,
  /\bdenied by taskwraith\b/i,
  /\b(?:blocked|denied)\b.{0,100}\b(?:permission|policy|posture|preset|workspace)\b/i,
  /\b(?:permission|policy|posture|preset|workspace)\b.{0,100}\b(?:blocked|denied)\b/i,
  /\bapproval\b.{0,80}\b(?:required|needed|unavailable|timed out|timeout)\b/i,
  /\b(?:requires?|needs?)\b.{0,80}\bapproval\b/i,
  /\bread[-_ ]?only\b.{0,80}\b(?:blocked|denied|unavailable|cannot|can't)\b/i,
  /\b(?:blocked|denied|unavailable|cannot|can't)\b.{0,80}\bread[-_ ]?only\b/i,
  /\boutside\b.{0,80}\bworkspace\b/i,
  /\bcannot prove an exact (?:file\/hunk )?mutation scope\b/i,
  /\bdid not provide exact edit scope\b/i,
  /\boutside the approved lane scope\b/i,
  /\bnot approved to write\b/i
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function serializedArgumentBytes(value: Record<string, unknown>): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return null
  }
}

export function isExplicitUserDeclineFailure(failure: string): boolean {
  return EXPLICIT_USER_DECLINE_PATTERNS.some((pattern) => pattern.test(failure))
}

export function isPermissionBoundaryFailure(failure: string): boolean {
  return (
    !isExplicitUserDeclineFailure(failure) &&
    PERMISSION_BOUNDARY_PATTERNS.some((pattern) => pattern.test(failure))
  )
}

export interface ToolPermissionRetryRequest {
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  failure: string
  rationale?: string
}

/** Internal host-issued route. It is not advertised until main wires issuance. */
export interface ToolPermissionOpportunityRequest {
  permissionOpportunityId: string
}

export interface ToolPermissionOpportunityReservation {
  request: PermissionOpportunityValidatedRequest
  targetArgumentsSha256: string
  /** Main must recompute the live binding inside this call immediately before consume. */
  consumeWithLiveBinding: () =>
    | PermissionOpportunityTakeResult
    | Promise<PermissionOpportunityTakeResult>
  release: () => PermissionOpportunityReleaseResult | Promise<PermissionOpportunityReleaseResult>
}

export type ToolPermissionOpportunityResolver = (
  permissionOpportunityId: string
) =>
  | { ok: true; reservation: ToolPermissionOpportunityReservation }
  | { ok: false; code: string; error: string }
  | Promise<
      | { ok: true; reservation: ToolPermissionOpportunityReservation }
      | { ok: false; code: string; error: string }
    >

export interface ToolPermissionRetryInstruction {
  available: true
  scope: 'one_exact_invocation'
  message: string
  targetArgumentsSha256: string
  tool: 'capability_invoke'
  arguments: {
    name: typeof TOOL_PERMISSION_RETRY_TOOL_NAME
    arguments: ToolPermissionRetryRequest
  }
}

export type ToolPermissionRetryValidationErrorCode =
  | 'invalid_request'
  | 'invalid_target'
  | 'non_retriable_target'
  | 'target_does_not_need_permission'
  | 'explicit_user_decline'
  | 'non_retriable_failure'
  | 'not_permission_failure'
  | 'invalid_target_arguments'
  | 'invalid_target_schema'

export type ToolPermissionRetryValidationResult =
  | { ok: true; request: ToolPermissionRetryRequest }
  | {
      ok: false
      code: ToolPermissionRetryValidationErrorCode
      message: string
      issues?: GatewayArgumentValidationIssue[]
    }

function profileFacingToolName(
  toolName: TaskWraithMcpToolName,
  definitions: readonly TaskWraithMcpToolDefinition[]
): TaskWraithMcpToolName {
  return toolName === 'ensemble_bossman_control' &&
    !definitions.some((definition) => definition.name === toolName) &&
    definitions.some((definition) => definition.name === 'ensemble_control')
    ? 'ensemble_control'
    : toolName
}

export function isToolPermissionOpportunityRequest(
  value: unknown
): value is ToolPermissionOpportunityRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.permissionOpportunityId === 'string' &&
    value.permissionOpportunityId.trim().length > 0
  )
}

function hasPermissionOpportunityId(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'permissionOpportunityId')
}

export function validateToolPermissionRetryRequest(input: {
  value: unknown
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
}): ToolPermissionRetryValidationResult {
  if (!isRecord(input.value)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'A one-shot permission retry requires an object payload.'
    }
  }

  const requestedToolName = nonEmptyString(input.value.toolName)
  if (!requestedToolName || !isTaskWraithMcpToolName(requestedToolName)) {
    return {
      ok: false,
      code: 'invalid_target',
      message: 'The retry target must be an exact canonical TaskWraith tool name.'
    }
  }
  const rawToolName = requestedToolName
  if (NON_RETRIABLE_TARGETS.has(rawToolName)) {
    return {
      ok: false,
      code: 'non_retriable_target',
      message: `${rawToolName} has a dedicated or non-delegable approval path and cannot use one-shot permission retry.`
    }
  }
  if (input.isAutoAllowed(rawToolName)) {
    return {
      ok: false,
      code: 'target_does_not_need_permission',
      message: `${rawToolName} already skips the generic TaskWraith permission gate; its failure cannot be fixed by a one-shot gate override.`
    }
  }

  const failure = nonEmptyString(input.value.failure)
  if (!failure || failure.length > MAX_FAILURE_LENGTH) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `failure must contain between 1 and ${MAX_FAILURE_LENGTH} characters.`
    }
  }
  if (isExplicitUserDeclineFailure(failure)) {
    return {
      ok: false,
      code: 'explicit_user_decline',
      message:
        'The prior result says the user explicitly declined or cancelled. Respect that decision and do not request the same permission again.'
    }
  }
  if (
    rawToolName !== 'run_shell_command' &&
    NON_RETRIABLE_ENSEMBLE_LANE_PATTERNS.some((pattern) => pattern.test(failure))
  ) {
    return {
      ok: false,
      code: 'non_retriable_failure',
      message:
        'A one-shot permission retry cannot expand an Ensemble lane write scope. Report the blocked path to the orchestrator instead of asking the user to retry the same invocation.'
    }
  }
  if (
    !isUnscopedProcessAuthorityTool(rawToolName) &&
    UNPROVABLE_MUTATION_SCOPE_PATTERN.test(failure)
  ) {
    return {
      ok: false,
      code: 'non_retriable_failure',
      message:
        `${rawToolName} cannot use one-shot permission retry for an unprovable mutation scope; ` +
        'the caller must choose an exact workspace tool instead.'
    }
  }
  if (!isPermissionBoundaryFailure(failure)) {
    return {
      ok: false,
      code: 'not_permission_failure',
      message:
        'The prior result does not look like a permission, policy, sandbox, or read-only boundary. Diagnose the tool error instead of escalating it.'
    }
  }

  if (!isRecord(input.value.arguments)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'arguments must be the exact object from the failed target invocation.'
    }
  }
  const argumentBytes = serializedArgumentBytes(input.value.arguments)
  if (argumentBytes === null || argumentBytes > MAX_ARGUMENT_BYTES) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `Target arguments must be JSON-serializable and no larger than ${MAX_ARGUMENT_BYTES} bytes.`
    }
  }

  const rationale = nonEmptyString(input.value.rationale)
  if (rationale && rationale.length > MAX_RATIONALE_LENGTH) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `rationale must be no longer than ${MAX_RATIONALE_LENGTH} characters.`
    }
  }

  const definition = input.definitions.find((entry) => entry.name === rawToolName)
  if (!definition) {
    return {
      ok: false,
      code: 'invalid_target',
      message: `The canonical definition for ${rawToolName} is unavailable.`
    }
  }
  const argumentValidation = validateGatewayToolArguments(
    definition.inputSchema,
    input.value.arguments
  )
  if (!argumentValidation.ok) {
    return {
      ok: false,
      code:
        argumentValidation.code === 'invalid_schema'
          ? 'invalid_target_schema'
          : 'invalid_target_arguments',
      message:
        argumentValidation.code === 'invalid_schema'
          ? `${rawToolName} cannot be retried because its canonical input schema is invalid.`
          : `${rawToolName} cannot be retried because the supplied arguments do not match its canonical schema.`,
      issues: argumentValidation.issues
    }
  }

  return {
    ok: true,
    request: {
      toolName: rawToolName,
      arguments: input.value.arguments,
      failure,
      ...(rationale ? { rationale } : {})
    }
  }
}

/**
 * Revalidate a request retained by Electron main without treating its stored
 * failure text as fresh provider evidence. Eligibility was established at issue
 * time by the typed boundary code; this checks only the current target schema
 * and the generic target ceilings before host-specific guards run downstream.
 */
export function validateHostIssuedToolPermissionRetryRequest(input: {
  request: PermissionOpportunityValidatedRequest
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
}): ToolPermissionRetryValidationResult {
  const requestedToolName = nonEmptyString(input.request.toolName)
  if (!requestedToolName || !isTaskWraithMcpToolName(requestedToolName)) {
    return {
      ok: false,
      code: 'invalid_target',
      message: 'The retained permission opportunity has no canonical TaskWraith target.'
    }
  }
  if (!isPermissionOpportunityBoundaryCode(input.request.boundaryCode)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'The retained permission opportunity has no recognised host boundary code.'
    }
  }
  const failure = nonEmptyString(input.request.failure)
  if (!failure || failure.length > MAX_FAILURE_LENGTH) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'The retained permission opportunity has invalid failure evidence.'
    }
  }
  const profileFacingTool = profileFacingToolName(requestedToolName, input.definitions)
  if (NON_RETRIABLE_TARGETS.has(profileFacingTool)) {
    return {
      ok: false,
      code: 'non_retriable_target',
      message: `${profileFacingTool} has a dedicated or non-delegable approval path and cannot use one-shot permission retry.`
    }
  }
  if (input.isAutoAllowed(profileFacingTool)) {
    return {
      ok: false,
      code: 'target_does_not_need_permission',
      message: `${profileFacingTool} already skips the generic TaskWraith permission gate; its failure cannot be fixed by a one-shot gate override.`
    }
  }
  if (!isRecord(input.request.arguments)) {
    return {
      ok: false,
      code: 'invalid_target_arguments',
      message: `${profileFacingTool} cannot be retried because the retained arguments are not an object.`
    }
  }
  const argumentBytes = serializedArgumentBytes(input.request.arguments)
  if (argumentBytes === null || argumentBytes > MAX_ARGUMENT_BYTES) {
    return {
      ok: false,
      code: 'invalid_target_arguments',
      message: `${profileFacingTool} cannot be retried because the retained arguments exceed the current size ceiling.`
    }
  }
  const definition = input.definitions.find((entry) => entry.name === profileFacingTool)
  if (!definition) {
    return {
      ok: false,
      code: 'invalid_target',
      message: `The canonical definition for ${profileFacingTool} is unavailable.`
    }
  }
  const argumentValidation = validateGatewayToolArguments(
    definition.inputSchema,
    input.request.arguments
  )
  if (!argumentValidation.ok) {
    return {
      ok: false,
      code:
        argumentValidation.code === 'invalid_schema'
          ? 'invalid_target_schema'
          : 'invalid_target_arguments',
      message:
        argumentValidation.code === 'invalid_schema'
          ? `${profileFacingTool} cannot be retried because its canonical input schema is invalid.`
          : `${profileFacingTool} cannot be retried because the retained arguments no longer match its canonical schema.`,
      issues: argumentValidation.issues
    }
  }
  return {
    ok: true,
    request: {
      toolName: profileFacingTool,
      arguments: input.request.arguments,
      failure
    }
  }
}

export function buildToolPermissionRetryInstruction(input: {
  available: boolean
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  failure: string
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
}): ToolPermissionRetryInstruction | null {
  if (!input.available) return null
  const profileFacingTool = profileFacingToolName(input.toolName, input.definitions)
  const validation = validateToolPermissionRetryRequest({
    value: {
      toolName: profileFacingTool,
      arguments: input.arguments,
      failure: input.failure
    },
    definitions: input.definitions,
    isAutoAllowed: input.isAutoAllowed
  })
  if (!validation.ok) return null
  return {
    available: true,
    scope: 'one_exact_invocation',
    message:
      validation.request.toolName === 'run_shell_command'
        ? 'Opaque shell process effects cannot be proven as exact file locks; ask for one auditable host execution of the exact command and cwd below.'
        : validation.request.toolName === 'start_background_process'
          ? 'A persistent process cannot be proven as exact file locks; ask for one auditable async-access start of the exact command and cwd below. It stays registered, readable, and cancellable.'
          : 'If this is a policy boundary rather than a user decision, ask for a one-shot retry with the exact invocation below.',
    targetArgumentsSha256: argumentsFingerprint(validation.request.arguments),
    tool: 'capability_invoke',
    arguments: {
      name: TOOL_PERMISSION_RETRY_TOOL_NAME,
      arguments: validation.request
    }
  }
}

export function normalizeValidatedToolPermissionRetryRequest(
  request: ToolPermissionRetryRequest
): ToolPermissionRetryRequest {
  if (!isPortableEnsembleControlToolName(request.toolName)) return request
  const toolName = canonicalTaskWraithToolName(request.toolName)
  const normalizedArguments = normalizePortableEnsembleControlArguments(
    request.toolName,
    request.arguments
  )
  if (!isTaskWraithMcpToolName(toolName) || !isRecord(normalizedArguments)) return request
  return {
    ...request,
    toolName,
    arguments: normalizedArguments
  }
}

function argumentsFingerprint(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

export interface OneOffToolPermissionRetryMarker {
  targetToolName: TaskWraithMcpToolName
  targetArgumentsSha256: string
}

export function createOneOffToolPermissionRetryMarker(
  request: ToolPermissionRetryRequest
): OneOffToolPermissionRetryMarker {
  return {
    targetToolName: request.toolName,
    targetArgumentsSha256: argumentsFingerprint(request.arguments)
  }
}

export function isOneOffToolPermissionRetryForTarget(
  marker: OneOffToolPermissionRetryMarker | null | undefined,
  toolName: TaskWraithMcpToolName,
  args: Record<string, unknown>
): boolean {
  return Boolean(
    marker &&
    marker.targetToolName === toolName &&
    marker.targetArgumentsSha256 === argumentsFingerprint(args)
  )
}

export function buildToolPermissionRetryApprovalPrompt(input: {
  providerLabel: string
  request: ToolPermissionRetryRequest
  targetPreview: unknown
}): {
  method: string
  title: string
  body: string
  preview: Record<string, unknown>
} {
  const failureSummary =
    input.request.failure.length > 1000
      ? `${input.request.failure.slice(0, 997)}...`
      : input.request.failure
  const targetPreview = isRecord(input.targetPreview) ? input.targetPreview : {}
  const unscopedHostShell = input.request.toolName === 'run_shell_command'
  // A background process is opaque like a shell command but NOT unsandboxed:
  // TaskWraith keeps it in the background-process registry with a workspace-
  // jailed cwd, captured logs, and an explicit kill. Reusing the shell copy
  // here would over-warn and under-describe what the user is actually allowing.
  const managedBackgroundProcess = input.request.toolName === 'start_background_process'
  return {
    method: 'toolPermissionRetry',
    title: `Allow ${input.providerLabel} to retry ${input.request.toolName} once?`,
    body: unscopedHostShell
      ? 'The agent could not express this shell command as exact file locks. Accepting runs this exact command once in the TaskWraith host process, outside a workspace sandbox and without workspace locks; it may race active writers. Review the command and cwd shown below. This does not create a session or workspace grant.'
      : managedBackgroundProcess
        ? 'The agent could not express this long-running process as exact file locks. Accepting starts this exact command once as a managed TaskWraith background process: its working directory stays inside the workspace, its output is captured, and you can stop it at any time from the background process list. It keeps running after the tool call ends, and it is not covered by workspace locks, so it may race active writers. This does not create a session or workspace grant.'
        : `The agent reports that ${input.request.toolName} hit a permission boundary. ` +
          'Accepting retries only the exact invocation shown below and does not create a session or workspace grant.',
    preview: {
      ...targetPreview,
      permissionRetry: {
        kind: 'tool_permission_retry',
        targetToolName: input.request.toolName,
        targetArgumentsSha256: argumentsFingerprint(input.request.arguments),
        exactArguments: input.request.arguments,
        ...(unscopedHostShell
          ? {
              executionBoundary: 'host-unsandboxed-one-shot',
              workspaceMutationContainment: 'none-explicit-user-one-shot',
              exactCommand: input.request.arguments.command,
              exactCwd: input.request.arguments.cwd
            }
          : {}),
        ...(managedBackgroundProcess
          ? {
              executionBoundary: 'managed-background-process-one-shot',
              workspaceMutationContainment: 'registry-managed-cancellable',
              exactCommand: input.request.arguments.command,
              exactCwd: input.request.arguments.cwd
            }
          : {}),
        priorFailure: failureSummary,
        ...(input.request.rationale ? { rationale: input.request.rationale } : {})
      }
    }
  }
}

/**
 * The desktop prompt receives exact arguments, but permanent approval records
 * retain only their shape and fingerprint. The fingerprint is already part of
 * the live preview and binds the one-shot marker used at execution.
 */
function redactPermissionOpportunityValue(
  value: unknown,
  ancestors: Set<object>,
  depth = 0
): {
  value: unknown
  redacted: boolean
} {
  if (depth > 24) return { value: '[redacted nested value]', redacted: true }
  if (typeof value === 'string') {
    const tokenRedacted = value.replace(
      /twp_[A-Za-z0-9_-]{43}/g,
      '[redacted permission opportunity]'
    )
    const tokenWasRedacted = tokenRedacted !== value
    const trimmed = tokenRedacted.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { value: tokenRedacted, redacted: tokenWasRedacted }
    }
    try {
      const parsed = JSON.parse(tokenRedacted) as unknown
      const next = redactPermissionOpportunityValue(parsed, ancestors, depth + 1)
      return next.redacted || tokenWasRedacted
        ? { value: JSON.stringify(next.value), redacted: true }
        : { value, redacted: false }
    } catch {
      return { value: tokenRedacted, redacted: tokenWasRedacted }
    }
  }
  if (!value || typeof value !== 'object') return { value, redacted: false }
  if (ancestors.has(value)) return { value: '[redacted circular value]', redacted: true }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      let redacted = false
      const items = value.map((entry) => {
        const next = redactPermissionOpportunityValue(entry, ancestors, depth + 1)
        redacted ||= next.redacted
        return next.value
      })
      return { value: items, redacted }
    }
    const record = value as Record<string, unknown>
    let redacted = false
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'permissionOpportunityId') {
        redacted = true
        result.permissionOpportunityId = '[redacted]'
        continue
      }
      const next = redactPermissionOpportunityValue(entry, ancestors, depth + 1)
      redacted ||= next.redacted
      result[key] = next.value
    }
    if (redacted) result.permissionOpportunityIdRedacted = true
    return { value: result, redacted }
  } finally {
    ancestors.delete(value)
  }
}

/** Remove opaque opportunity ids from arbitrary durable event/ledger payload shapes. */
export function redactPermissionOpportunityIdsForDurableStorage<T>(payload: T): T {
  return redactPermissionOpportunityValue(payload, new Set<object>()).value as T
}

export function toolPermissionRetryApprovalPayloadForDurableStorage<T>(payload: T): T {
  if (!isRecord(payload) || !isRecord(payload.preview)) {
    return redactPermissionOpportunityIdsForDurableStorage(payload)
  }
  const permissionRetry = payload.preview.permissionRetry
  if (!isRecord(permissionRetry)) return redactPermissionOpportunityIdsForDurableStorage(payload)
  const exactArguments = isRecord(permissionRetry.exactArguments)
    ? permissionRetry.exactArguments
    : null
  const exactArgumentByteLength = exactArguments
    ? (serializedArgumentBytes(exactArguments) ?? 0)
    : 0
  const durablePermissionRetry = { ...permissionRetry }
  if (exactArguments) {
    delete durablePermissionRetry.exactArguments
    delete durablePermissionRetry.priorFailure
    delete durablePermissionRetry.rationale
  }
  const durablePayload = exactArguments
    ? {
        ...payload,
        preview: {
          ...payload.preview,
          permissionRetry: {
            ...durablePermissionRetry,
            exactArgumentsRedacted: true,
            agentNarrativeRedacted: true,
            exactArgumentKeys: Object.keys(exactArguments).sort().slice(0, 64),
            exactArgumentByteLength
          }
        }
      }
    : payload
  return redactPermissionOpportunityIdsForDurableStorage(durablePayload)
}

export type OneOffToolPermissionRetryExecutionResult<TResult> =
  | { kind: 'not_approved' }
  | { kind: 'executed'; result: TResult }

export async function executeOneOffToolPermissionRetry<TResult>(input: {
  requestApproval: () => Promise<boolean>
  executeTarget: () => Promise<TResult>
}): Promise<OneOffToolPermissionRetryExecutionResult<TResult>> {
  if (!(await input.requestApproval())) return { kind: 'not_approved' }
  return { kind: 'executed', result: await input.executeTarget() }
}

export interface ToolPermissionRetryTargetResult {
  text: string
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export type PreparedToolPermissionRetryTarget<TResult> =
  | { ok: true; targetPreview: unknown }
  | { ok: false; error: string }
  | { ok: false; result: TResult }

export function oneOffToolPermissionRetryGuardError(input: {
  toolName: TaskWraithMcpToolName
  networkError?: string | null
  externalPathDetected?: boolean
  alwaysPrompts?: boolean
}): string | null {
  if (input.networkError) return input.networkError
  if (input.externalPathDetected) {
    return 'One-shot permission retry cannot replace a signed external-path grant. Retry the original tool through the normal external-path approval flow.'
  }
  if (input.alwaysPrompts) {
    return `${input.toolName} uses a dedicated every-call approval path and cannot use generic one-shot permission retry.`
  }
  return null
}

export function prepareToolPermissionRetryTarget<TResult>(input: {
  toolName: TaskWraithMcpToolName
  routeError?: string | null
  workspaceError?: string | null
  providerPolicyError?: string | null
  networkError?: string | null
  externalPathDetected?: boolean
  alwaysPrompts?: boolean
  unsupportedResult?: TResult | null
  buildTargetPreview: () => unknown
}): PreparedToolPermissionRetryTarget<TResult> {
  const error =
    input.routeError ||
    input.workspaceError ||
    input.providerPolicyError ||
    oneOffToolPermissionRetryGuardError({
      toolName: input.toolName,
      networkError: input.networkError,
      externalPathDetected: input.externalPathDetected,
      alwaysPrompts: input.alwaysPrompts
    })
  if (error) return { ok: false, error }
  if (input.unsupportedResult) return { ok: false, result: input.unsupportedResult }
  return { ok: true, targetPreview: input.buildTargetPreview() }
}

export interface ToolPermissionRetryDecision {
  action: AgentApprovalAction
  decisionSource: 'user' | 'system'
}

const DIRECT_USER_ACCEPT_ACTIONS = new Set<AgentApprovalAction>([
  'accept',
  'acceptForSession',
  'acceptForWorkspace',
  'grantExternalPathRead',
  'grantExternalPathEdit'
])

/**
 * The ordinary shell-service gate is the authority for an opaque host command.
 * A direct approval has shown the exact command; an automatic approval has
 * resolved through the run's signed policy, session/workspace grant, Full
 * Access, or another audited user-configured authority. Either must be reused
 * by lock admission or TaskWraith asks twice and turns an explicit Shell
 * Commands grant back into an every-call prompt.
 *
 * `automaticApproval` is supplied only after the central approval orchestrator
 * returned true without opening a decision modal. The command/cwd still remain
 * in that orchestrator's durable approval receipt. Read-only shell commands do
 * not need this mutation escape hatch and stay on their ordinary path.
 */
export function approvedShellAuthorityAuthorizesUnscopedShell(input: {
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  allowed: boolean
  automaticApproval?: boolean
  decision?: ToolPermissionRetryDecision
}): boolean {
  const directUserApproval =
    input.decision?.decisionSource === 'user' &&
    DIRECT_USER_ACCEPT_ACTIONS.has(input.decision.action)
  if (
    !isUnscopedProcessAuthorityTool(input.toolName) ||
    !input.allowed ||
    (!input.automaticApproval && !directUserApproval)
  ) {
    return false
  }
  const command = input.arguments.command
  if (typeof command !== 'string' || !command.trim()) return false
  // A read-only ONE-SHOT needs no mutation escape hatch, but a read-looking
  // command started as a PERSISTENT process is still an opaque long-lived
  // child (`tail -f`, a watcher, a server). Classifying it as read-only would
  // route it back into claim derivation and re-create the dead end.
  if (input.toolName === 'start_background_process') return true
  return !isReadOnlyShellCommand(command)
}

export interface ToolPermissionRetryOrchestrationResult<TResult> {
  text: string
  isError: boolean
  targetToolName?: TaskWraithMcpToolName
  targetResult?: TResult
  targetExecuted?: boolean
}

function targetResultIsError(result: ToolPermissionRetryTargetResult): boolean {
  return (
    result.isError === true ||
    (isRecord(result.structuredContent) && result.structuredContent.ok === false)
  )
}

/**
 * Own the one-shot retry lifecycle outside the composition root. Host-specific
 * route/path/network checks and approval transport are injected, but validation,
 * decision semantics, exact retry consumption, and result propagation stay here.
 */
export async function orchestrateToolPermissionRetry<
  TResult extends ToolPermissionRetryTargetResult
>(input: {
  value: unknown
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
  providerLabel: string
  /**
   * Main-owned atomic resolver for a host-issued opportunity. The resolver must
   * bind its id to the live provider/run/chat/profile/workspace before returning
   * the retained target; caller-supplied args never reach this branch.
   */
  resolvePermissionOpportunity?: ToolPermissionOpportunityResolver
  prepareTarget: (request: ToolPermissionRetryRequest) => PreparedToolPermissionRetryTarget<TResult>
  requestApproval: (
    prompt: ReturnType<typeof buildToolPermissionRetryApprovalPrompt>,
    onDecision: (decision: ToolPermissionRetryDecision) => void
  ) => Promise<boolean>
  executeTarget: (
    request: ToolPermissionRetryRequest,
    marker: OneOffToolPermissionRetryMarker
  ) => Promise<TResult>
}): Promise<ToolPermissionRetryOrchestrationResult<TResult>> {
  let validatedRequest: ToolPermissionRetryRequest
  let opportunityReservation: ToolPermissionOpportunityReservation | undefined
  if (isToolPermissionOpportunityRequest(input.value)) {
    if (!input.resolvePermissionOpportunity) {
      return {
        isError: true,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          code: 'opportunity_unavailable',
          error: 'This run cannot redeem a host-issued permission opportunity.'
        })
      }
    }
    const resolvedOpportunity = await input.resolvePermissionOpportunity(
      input.value.permissionOpportunityId
    )
    if (!resolvedOpportunity.ok) {
      return {
        isError: true,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          code: resolvedOpportunity.code,
          error: resolvedOpportunity.error
        })
      }
    }
    opportunityReservation = resolvedOpportunity.reservation
    const validation = validateHostIssuedToolPermissionRetryRequest({
      request: opportunityReservation.request,
      definitions: input.definitions,
      isAutoAllowed: input.isAutoAllowed
    })
    if (!validation.ok) {
      try {
        await opportunityReservation.release()
      } catch {
        // A failed release never authorizes execution; the registry expires it.
      }
      return {
        isError: true,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          code: validation.code,
          error: validation.message,
          ...(validation.issues ? { issues: validation.issues } : {})
        })
      }
    }
    validatedRequest = validation.request
  } else {
    if (hasPermissionOpportunityId(input.value)) {
      return {
        isError: true,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          code: 'invalid_opportunity_request',
          error: 'A permission opportunity request must contain only permissionOpportunityId.'
        })
      }
    }
    const validation = validateToolPermissionRetryRequest({
      value: input.value,
      definitions: input.definitions,
      isAutoAllowed: input.isAutoAllowed
    })
    if (!validation.ok) {
      return {
        isError: true,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          code: validation.code,
          error: validation.message,
          ...(validation.issues ? { issues: validation.issues } : {})
        })
      }
    }
    validatedRequest = validation.request
  }

  // Validate against the immutable profile-facing schema first, then bind the
  // exact approval and marker to the canonical invocation that will execute.
  const request = normalizeValidatedToolPermissionRetryRequest(validatedRequest)
  const releaseOpportunityReservation = async (): Promise<void> => {
    if (!opportunityReservation) return
    try {
      await opportunityReservation.release()
    } catch {
      // A failed release never authorizes execution; the registry expires it.
    }
  }
  let prepared: PreparedToolPermissionRetryTarget<TResult>
  try {
    prepared = input.prepareTarget(request)
  } catch (error) {
    await releaseOpportunityReservation()
    throw error
  }
  if (!prepared.ok) {
    await releaseOpportunityReservation()
    if ('result' in prepared) {
      return {
        text: prepared.result.text,
        isError: true,
        targetToolName: request.toolName,
        targetResult: prepared.result
      }
    }
    return {
      isError: true,
      targetToolName: request.toolName,
      text: mcpJson({
        ok: false,
        tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
        targetTool: request.toolName,
        error: prepared.error
      })
    }
  }

  let prompt: ReturnType<typeof buildToolPermissionRetryApprovalPrompt>
  try {
    prompt = buildToolPermissionRetryApprovalPrompt({
      providerLabel: input.providerLabel,
      request,
      targetPreview: prepared.targetPreview
    })
  } catch (error) {
    await releaseOpportunityReservation()
    throw error
  }
  if (opportunityReservation) {
    let opportunityDecision: ToolPermissionRetryDecision | undefined
    let approved: boolean
    try {
      approved = await input.requestApproval(prompt, (nextDecision) => {
        opportunityDecision = nextDecision
      })
    } catch (error) {
      await releaseOpportunityReservation()
      throw error
    }
    if (!approved) {
      if (opportunityDecision) {
        try {
          await opportunityReservation.consumeWithLiveBinding()
        } catch {
          // A release is unsafe after a user/system decision; expiry remains the backstop.
        }
      } else {
        await releaseOpportunityReservation()
      }
      const userDeclined =
        opportunityDecision?.decisionSource === 'user' &&
        (opportunityDecision.action === 'decline' || opportunityDecision.action === 'cancel')
      return {
        isError: true,
        targetToolName: request.toolName,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          targetTool: request.toolName,
          error: userDeclined
            ? `The user ${opportunityDecision?.action === 'cancel' ? 'cancelled' : 'declined'} this one-shot permission retry. Do not ask again.`
            : opportunityDecision?.decisionSource === 'system'
              ? 'The one-shot permission retry timed out or was cancelled by the system. The target was not executed.'
              : 'The one-shot permission retry was not approved. The target was not executed.'
        })
      }
    }
    let consumed: PermissionOpportunityTakeResult
    try {
      consumed = await opportunityReservation.consumeWithLiveBinding()
    } catch {
      return {
        isError: true,
        targetToolName: request.toolName,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          targetTool: request.toolName,
          code: 'opportunity_consume_failed',
          error: 'The approved permission opportunity could not be consumed.'
        })
      }
    }
    if (!consumed.ok) {
      return {
        isError: true,
        targetToolName: request.toolName,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          targetTool: request.toolName,
          code: consumed.code,
          error: consumed.error
        })
      }
    }
    const retainedRequest = opportunityReservation.request
    if (
      consumed.opportunity.targetArgumentsSha256 !== opportunityReservation.targetArgumentsSha256 ||
      argumentsFingerprint(consumed.opportunity.request.arguments) !==
        opportunityReservation.targetArgumentsSha256 ||
      consumed.opportunity.request.toolName !== retainedRequest.toolName ||
      consumed.opportunity.request.boundaryCode !== retainedRequest.boundaryCode ||
      consumed.opportunity.request.failure !== retainedRequest.failure
    ) {
      return {
        isError: true,
        targetToolName: request.toolName,
        text: mcpJson({
          ok: false,
          tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
          targetTool: request.toolName,
          code: 'opportunity_target_mismatch',
          error:
            'The consumed permission opportunity did not match the invocation reviewed by the user.'
        })
      }
    }
    const consumedRequest = normalizeValidatedToolPermissionRetryRequest({
      toolName: consumed.opportunity.request.toolName,
      arguments: consumed.opportunity.request.arguments,
      failure: consumed.opportunity.request.failure
    })
    const result = await input.executeTarget(
      consumedRequest,
      createOneOffToolPermissionRetryMarker(consumedRequest)
    )
    return {
      text: result.text,
      isError: targetResultIsError(result),
      targetToolName: consumedRequest.toolName,
      targetResult: result,
      targetExecuted: true
    }
  }
  let decision: ToolPermissionRetryDecision | undefined
  const outcome = await executeOneOffToolPermissionRetry({
    requestApproval: () =>
      input.requestApproval(prompt, (nextDecision) => {
        decision = nextDecision
      }),
    executeTarget: () =>
      input.executeTarget(request, createOneOffToolPermissionRetryMarker(request))
  })
  if (outcome.kind === 'not_approved') {
    const userDeclined =
      decision?.decisionSource === 'user' &&
      (decision.action === 'decline' || decision.action === 'cancel')
    return {
      isError: true,
      targetToolName: request.toolName,
      text: mcpJson({
        ok: false,
        tool: TOOL_PERMISSION_RETRY_TOOL_NAME,
        targetTool: request.toolName,
        error: userDeclined
          ? `The user ${decision?.action === 'cancel' ? 'cancelled' : 'declined'} this one-shot permission retry. Do not ask again.`
          : decision?.decisionSource === 'system'
            ? 'The one-shot permission retry timed out or was cancelled by the system. The target was not executed.'
            : 'The one-shot permission retry was not approved. The target was not executed.'
      })
    }
  }
  return {
    text: outcome.result.text,
    isError: targetResultIsError(outcome.result),
    targetToolName: request.toolName,
    targetResult: outcome.result,
    targetExecuted: true
  }
}
