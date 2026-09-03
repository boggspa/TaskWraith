import type { TaskWraithMcpToolDefinition } from '../McpToolCatalog'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { validateGatewayToolArguments, type GatewayArgumentValidationIssue } from './McpToolGateway'
import { validateEmulatorStepToolInput } from '../../shared/emulatorCanvas'

/**
 * Direct tools whose provider-emitted arguments must be schema-checked before
 * any permission prompt. Keep this list narrow: older direct tools intentionally
 * accept compatibility aliases that are not all represented in their schemas.
 *
 * Membership is earned by audit, not by traffic. A tool qualifies only when
 * every argument spelling its handler reads is either canonical or coalesced by
 * TOOL_ARGUMENT_ALIAS_GROUPS (which runs BEFORE this check), so schema
 * validation can never reject a call that would have executed. Audited
 * 2026-09-03 against the live handlers; the exclusions are recorded below
 * because each one looks like an obvious candidate and is not:
 *
 *   create_directory  reads ['path','directory'], and 'directory' is coalesced
 *                     only for list_directory (TOOL_ARGUMENT_ALIAS_TOOL_RESTRICTIONS).
 *   move_path         reads source/sourcePath/old_path/oldPath and
 *                     destination/destinationPath/new_path/newPath — none coalesced.
 *   workspace_search  accepts 'pattern' as a second spelling of 'query'.
 *   ensemble_poll_response  reads 'poll_id' uncoalesced.
 *   git_commit        declares additionalProperties:false over a three-field
 *                     required set; its handoff aliases need their own audit.
 *
 * Adding any of those would reject invocations that succeed today, which is a
 * capability narrowing rather than a repair.
 */
const PRE_APPROVAL_SCHEMA_VALIDATED_TOOLS: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'ensemble_bossman_control',
  'ensemble_control',
  'emulator_open',
  'emulator_observe',
  'emulator_step',
  // Workspace I/O. Every alias these handlers read (file_path/filePath,
  // old_string/oldString, new_string/newString, content/contents/text,
  // command/cmd/script, cwd/working_directory/workdir) is a canonical key or a
  // coalesced alias, so `{}` and half-populated calls are the only casualties.
  'read_file',
  'write_file',
  'replace',
  'run_shell_command',
  'delete_path',
  // No alias spellings at all; each already refuses an empty required field in
  // its handler, so this only moves the refusal ahead of the approval prompt.
  'todo_write',
  'ask_user_question',
  // Already carry schema examples that nothing surfaced before this list grew.
  'canvas_key',
  'canvas_drive_verify'
])

export type McpPreApprovalArgumentValidationResult =
  | { ok: true }
  | {
      ok: false
      code: 'invalid_arguments' | 'invalid_tool_schema'
      message: string
      issues: GatewayArgumentValidationIssue[]
    }

function firstObjectExample(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!Array.isArray(schema?.examples)) return null
  const example = schema.examples.find((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
  )
  return example || null
}

function invalidArgumentMessage(
  toolName: TaskWraithMcpToolName,
  schema: Record<string, unknown> | undefined,
  issues: GatewayArgumentValidationIssue[],
  definitions: readonly TaskWraithMcpToolDefinition[]
): string {
  const details = issues.map((issue) => issue.message).join(' ')
  let example = firstObjectExample(schema)
  if (!example && toolName === 'ensemble_control') {
    const canonical = definitions.find((entry) => entry.name === 'ensemble_bossman_control')
    example = firstObjectExample(canonical?.inputSchema)
  }
  const exampleHint = example
    ? ` Retry with a populated object such as ${JSON.stringify(example)}.`
    : ''
  return `${toolName} was rejected before approval because its arguments are invalid. ${details}${exampleHint} Do not retry the same invalid invocation.`
}

/**
 * Reject known high-impact malformed direct calls before TaskWraith asks the
 * user to approve them. Provider-native schema enforcement is advisory: a model
 * can still emit `{}` for a schema with required fields, so the host must not
 * make the user approve an invocation that its own handler will immediately
 * reject.
 */
export function validateMcpToolArgumentsBeforeApproval(
  toolName: TaskWraithMcpToolName,
  args: Record<string, unknown>,
  definitions: readonly TaskWraithMcpToolDefinition[]
): McpPreApprovalArgumentValidationResult {
  if (!PRE_APPROVAL_SCHEMA_VALIDATED_TOOLS.has(toolName)) return { ok: true }

  const definition = definitions.find((entry) => entry.name === toolName)
  if (!definition) {
    return {
      ok: false,
      code: 'invalid_tool_schema',
      message: `${toolName} was rejected before approval because its canonical tool definition is missing.`,
      issues: []
    }
  }

  const validation = validateGatewayToolArguments(definition.inputSchema, args)
  if (validation.ok) {
    if (toolName !== 'emulator_step') return validation
    const emulatorInput = validateEmulatorStepToolInput({
      expectedObservationId: args.expectedObservationId,
      segments: args.segments,
      ...(args.requireIndependentVerifier !== undefined
        ? { requireIndependentVerifier: args.requireIndependentVerifier }
        : {})
    })
    if (emulatorInput.ok) return validation
    return {
      ok: false,
      code: 'invalid_arguments',
      message: `${toolName} was rejected before approval because its bounded emulator input is invalid. ${emulatorInput.reason} Do not retry the same invalid invocation.`,
      issues: []
    }
  }
  if (validation.code === 'invalid_schema') {
    return {
      ok: false,
      code: 'invalid_tool_schema',
      message: `${toolName} was rejected before approval because its canonical input schema is invalid.`,
      issues: validation.issues
    }
  }
  return {
    ok: false,
    code: 'invalid_arguments',
    message: invalidArgumentMessage(
      toolName,
      definition.inputSchema,
      validation.issues,
      definitions
    ),
    issues: validation.issues
  }
}
