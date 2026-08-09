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

export const TOOL_PERMISSION_RETRY_TOOL_NAME =
  'request_tool_permission' as const satisfies TaskWraithMcpToolName

const MAX_FAILURE_LENGTH = 4000
const MAX_RATIONALE_LENGTH = 600
const MAX_ARGUMENT_BYTES = 64 * 1024

const UNPROVABLE_MUTATION_SCOPE_PATTERN =
  /\bcannot prove an exact (?:file\/hunk )?mutation scope\b/i

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

  const rawToolName = nonEmptyString(input.value.toolName)
  if (!rawToolName || !isTaskWraithMcpToolName(rawToolName)) {
    return {
      ok: false,
      code: 'invalid_target',
      message: 'The retry target must be an exact canonical TaskWraith tool name.'
    }
  }
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
  if (rawToolName !== 'run_shell_command' && UNPROVABLE_MUTATION_SCOPE_PATTERN.test(failure)) {
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

export function buildToolPermissionRetryInstruction(input: {
  available: boolean
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  failure: string
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
}): ToolPermissionRetryInstruction | null {
  if (!input.available) return null
  const profileFacingToolName =
    input.toolName === 'ensemble_bossman_control' &&
    !input.definitions.some((definition) => definition.name === input.toolName) &&
    input.definitions.some((definition) => definition.name === 'ensemble_control')
      ? 'ensemble_control'
      : input.toolName
  const validation = validateToolPermissionRetryRequest({
    value: {
      toolName: profileFacingToolName,
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
        : 'If this is a policy boundary rather than a user decision, ask for a one-shot retry with the exact invocation below.',
    targetArgumentsSha256: argumentsFingerprint(validation.request.arguments),
    tool: 'capability_invoke',
    arguments: {
      name: TOOL_PERMISSION_RETRY_TOOL_NAME,
      arguments: validation.request
    }
  }
}

function normalizeValidatedToolPermissionRetryRequest(
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
  return {
    method: 'toolPermissionRetry',
    title: `Allow ${input.providerLabel} to retry ${input.request.toolName} once?`,
    body: unscopedHostShell
      ? 'The agent could not express this shell command as exact file locks. Accepting runs this exact command once in the TaskWraith host process, outside a workspace sandbox and without workspace locks; it may race active writers. Review the command and cwd shown below. This does not create a session or workspace grant.'
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
export function toolPermissionRetryApprovalPayloadForDurableStorage<T>(payload: T): T {
  if (!isRecord(payload) || !isRecord(payload.preview)) return payload
  const permissionRetry = payload.preview.permissionRetry
  if (!isRecord(permissionRetry) || !isRecord(permissionRetry.exactArguments)) return payload
  const exactArguments = permissionRetry.exactArguments
  const exactArgumentByteLength = serializedArgumentBytes(exactArguments) ?? 0
  const durablePermissionRetry = { ...permissionRetry }
  delete durablePermissionRetry.exactArguments
  delete durablePermissionRetry.priorFailure
  delete durablePermissionRetry.rationale
  return {
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
  } as T
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
    input.toolName !== 'run_shell_command' ||
    !input.allowed ||
    (!input.automaticApproval && !directUserApproval)
  ) {
    return false
  }
  const command = input.arguments.command
  return (
    typeof command === 'string' && command.trim().length > 0 && !isReadOnlyShellCommand(command)
  )
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

  // Validate against the immutable profile-facing schema first, then bind the
  // exact approval and marker to the canonical invocation that will execute.
  const request = normalizeValidatedToolPermissionRetryRequest(validation.request)
  const prepared = input.prepareTarget(request)
  if (!prepared.ok) {
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

  const prompt = buildToolPermissionRetryApprovalPrompt({
    providerLabel: input.providerLabel,
    request,
    targetPreview: prepared.targetPreview
  })
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
