import type { TaskWraithMcpToolDefinition } from '../McpToolCatalog'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { validateGatewayToolArguments, type GatewayArgumentValidationIssue } from './McpToolGateway'

/**
 * Direct tools whose provider-emitted arguments must be schema-checked before
 * any permission prompt. Keep this list narrow: older direct tools intentionally
 * accept compatibility aliases that are not all represented in their schemas.
 */
const PRE_APPROVAL_SCHEMA_VALIDATED_TOOLS: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'ensemble_bossman_control',
  'ensemble_control'
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
  if (validation.ok) return validation
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
