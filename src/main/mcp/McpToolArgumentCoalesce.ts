import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { stripToolNamespace } from '../../shared/canonicalToolCoalesce'
import { CAPABILITY_INVOKE_TOOL_NAME, gatewayToolDefinitions } from './McpToolGateway'

/**
 * Tool-aware ARGUMENT coalescing for the canonical TaskWraith MCP boundary.
 *
 * `canonicalToolCoalesce` already folds provider-native tool NAMES onto one
 * catalog identity. The remaining try-native / fail / retry friction is one
 * level down: a model reaches the right tool but spells its arguments the way
 * its own SDK taught it (`filePath`, `TargetFile`, `AbsolutePath`,
 * `CommandLine`, `CodeContent`, `old_str`, …), the schema validator rejects the
 * call, and the turn burns a round trip re-emitting the same intent.
 *
 * This module is the single normalizer for that. It runs BEFORE policy,
 * approval, workspace containment and write locks, so the executor, the
 * approval card and the audit ledger all see one canonical argument object.
 *
 * Three rules keep it honest:
 *
 * 1. TOOL-AWARE. An alias is only folded onto a canonical key that the target
 *    tool's own input schema actually declares, and never when the tool
 *    declares that alias as a real property of its own. `move_path` has
 *    `from`/`to` and no `path`, so nothing is invented for it.
 * 2. FAIL-CLOSED. When a canonical key and its alias disagree, the call is
 *    REJECTED with a structured conflict before any approval is raised. The
 *    normalizer never picks a winner — a silently chosen path or command is a
 *    mutation the user never authorized.
 * 3. LOSSLESS. The caller's original object is returned untouched alongside the
 *    canonical one for the audit trail, and unknown keys are preserved so the
 *    real schema validator still gets to produce the real error.
 *
 * Generic directory names remain excluded. The narrow `target_directory`,
 * `list_dir`, and `directory` aliases below apply to `list_directory` only,
 * never to find_files or move_path. The wrapper contract of `capability_invoke`
 * (`name` + `arguments`) is likewise NOT widened here; only the nested target
 * arguments are normalized.
 */

export interface ToolArgumentAliasGroup {
  canonicalKey: string
  aliases: readonly string[]
}

export interface AppliedToolArgumentAlias {
  /** Canonical key location, e.g. `path` or `arguments/command` for a gateway target. */
  path: string
  alias: string
  canonicalKey: string
  toolName: string
  /** True when the canonical key was supplied too and merely agreed. */
  duplicate: boolean
}

export interface ToolArgumentAliasConflict {
  path: string
  canonicalKey: string
  /** Every disagreeing spelling, canonical first, then aliases in table order. */
  suppliedKeys: string[]
  toolName: string
}

export interface ToolArgumentCoalesceOptions {
  /** Exact schema for the named tool. Wins over the catalogue; top level only. */
  inputSchema?: Record<string, unknown>
  /** Run-scoped schema lookup, e.g. the gateway's own definition list. */
  resolveInputSchema?: (toolName: string) => Record<string, unknown> | undefined
}

export type ToolArgumentCoalesceResult =
  | {
      ok: true
      toolName: string
      arguments: unknown
      originalArguments: unknown
      aliasesApplied: AppliedToolArgumentAlias[]
      schemaResolved: boolean
    }
  | {
      ok: false
      code: 'ambiguous_argument_alias'
      toolName: string
      message: string
      conflicts: ToolArgumentAliasConflict[]
      originalArguments: unknown
    }

/**
 * Alias spellings observed across the panel and recorded in the round evidence.
 * Order is contractual: conflicts and applied entries report in table order so
 * two hosts reading the same rejected call describe it identically.
 */
export const TOOL_ARGUMENT_ALIAS_GROUPS: readonly ToolArgumentAliasGroup[] = [
  {
    canonicalKey: 'command',
    aliases: [
      'cmd',
      'CommandLine',
      'commandLine',
      'command_line',
      'script',
      'shell_command',
      'exec'
    ]
  },
  {
    canonicalKey: 'cwd',
    aliases: ['Cwd', 'working_directory', 'workingDirectory', 'workdir']
  },
  {
    canonicalKey: 'path',
    aliases: [
      'file_path',
      'filePath',
      'FilePath',
      'TargetFile',
      'target_file',
      'targetFile',
      'AbsolutePath',
      'absolute_path',
      'absolutePath',
      'Path',
      'filename',
      'fileName',
      'file',
      'target_directory',
      'list_dir',
      'directory'
    ]
  },
  {
    canonicalKey: 'content',
    aliases: [
      'contents',
      'CodeContent',
      'codeContent',
      'code_content',
      'Content',
      'file_text',
      'fileText',
      'text'
    ]
  },
  {
    canonicalKey: 'old_string',
    aliases: ['oldString', 'old_str', 'old_text', 'oldText', 'TargetContent', 'target_content']
  },
  {
    canonicalKey: 'new_string',
    aliases: [
      'newString',
      'new_str',
      'new_text',
      'newText',
      'ReplacementContent',
      'replacement_content'
    ]
  },
  { canonicalKey: 'replace_all', aliases: ['replaceAll'] },
  { canonicalKey: 'patch', aliases: ['Patch', 'diff', 'unifiedDiff', 'unified_diff'] }
]

/** Native directory spellings must never change the meaning of find_files or move_path. */
const TOOL_ARGUMENT_ALIAS_TOOL_RESTRICTIONS: Readonly<Record<string, readonly string[]>> = {
  target_directory: ['list_directory'],
  list_dir: ['list_directory'],
  directory: ['list_directory']
}

function aliasAppliesToTool(alias: string, toolName: string): boolean {
  const allowedToolNames = TOOL_ARGUMENT_ALIAS_TOOL_RESTRICTIONS[alias]
  return !allowedToolNames || allowedToolNames.includes(stripToolNamespace(toolName))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** Structural equality — an alias that merely repeats the canonical value is not a conflict. */
function argumentValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => argumentValuesEqual(value, right[index]))
    )
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && argumentValuesEqual(left[key], right[key])
      )
    )
  }
  return false
}

let cachedSchemaIndex: Map<string, Record<string, unknown>> | null = null

/** Lazily indexed canonical + gateway-wrapper schemas. Built once per process. */
function schemaIndex(): Map<string, Record<string, unknown>> {
  if (cachedSchemaIndex) return cachedSchemaIndex
  const index = new Map<string, Record<string, unknown>>()
  for (const definition of createTaskWraithMcpToolDefinitions()) {
    if (definition.inputSchema) index.set(definition.name, definition.inputSchema)
  }
  for (const definition of gatewayToolDefinitions()) {
    if (definition.inputSchema) index.set(definition.name, definition.inputSchema)
  }
  cachedSchemaIndex = index
  return index
}

function declaredKeysFromSchema(schema: Record<string, unknown> | undefined): Set<string> | null {
  if (!schema) return null
  const properties = (schema as { properties?: unknown }).properties
  if (!isRecord(properties)) return new Set<string>()
  return new Set(Object.keys(properties))
}

function resolveSchema(
  toolName: string,
  options?: ToolArgumentCoalesceOptions
): Record<string, unknown> | undefined {
  const injected = options?.resolveInputSchema?.(toolName)
  if (injected) return injected
  const index = schemaIndex()
  const exact = index.get(toolName)
  if (exact) return exact
  // Schema LOOKUP only: a namespaced provider spelling still names one catalog
  // identity. The executor identity the caller passed in is never rewritten.
  const stripped = stripToolNamespace(toolName)
  return stripped === toolName ? undefined : index.get(stripped)
}

/**
 * Canonical argument keys the normalizer will reason about for a tool, or null
 * when no schema is known (in which case nothing is ever rewritten).
 */
export function canonicalArgumentKeysForTool(
  toolName: string,
  options?: ToolArgumentCoalesceOptions
): ReadonlySet<string> | null {
  if (options?.inputSchema) return declaredKeysFromSchema(options.inputSchema)
  return declaredKeysFromSchema(resolveSchema(toolName, options))
}

interface RecordCoalesceOutcome {
  arguments: Record<string, unknown>
  applied: AppliedToolArgumentAlias[]
  conflicts: ToolArgumentAliasConflict[]
}

function coalesceRecord(
  toolName: string,
  args: Record<string, unknown>,
  declared: ReadonlySet<string>,
  pathPrefix: string
): RecordCoalesceOutcome {
  const next: Record<string, unknown> = { ...args }
  const applied: AppliedToolArgumentAlias[] = []
  const conflicts: ToolArgumentAliasConflict[] = []

  for (const group of TOOL_ARGUMENT_ALIAS_GROUPS) {
    if (!declared.has(group.canonicalKey)) continue
    // An alias the tool declares as its own property is that tool's vocabulary.
    const suppliedAliases = group.aliases.filter(
      (alias) => !declared.has(alias) && hasOwn(args, alias) && aliasAppliesToTool(alias, toolName)
    )
    if (suppliedAliases.length === 0) continue

    const canonicalSupplied = hasOwn(args, group.canonicalKey)
    const suppliedKeys = canonicalSupplied
      ? [group.canonicalKey, ...suppliedAliases]
      : [...suppliedAliases]
    const values = suppliedKeys.map((key) => args[key])
    const agreed = values.every((value) => argumentValuesEqual(value, values[0]))

    if (!agreed) {
      conflicts.push({
        path: `${pathPrefix}${group.canonicalKey}`,
        canonicalKey: group.canonicalKey,
        suppliedKeys,
        toolName
      })
      continue
    }

    next[group.canonicalKey] = values[0]
    for (const alias of suppliedAliases) {
      delete next[alias]
      applied.push({
        path: `${pathPrefix}${group.canonicalKey}`,
        alias,
        canonicalKey: group.canonicalKey,
        toolName,
        duplicate: canonicalSupplied
      })
    }
  }

  return { arguments: next, applied, conflicts }
}

function conflictMessage(conflicts: readonly ToolArgumentAliasConflict[]): string {
  const details = conflicts
    .map(
      (conflict) =>
        `'${conflict.canonicalKey}' was supplied as ${conflict.suppliedKeys
          .map((key) => `'${key}'`)
          .join(' and ')} with different values`
    )
    .join('; ')
  return `${conflicts[0].toolName}: ${details}. TaskWraith will not choose between them — resend the call with one spelling per argument.`
}

/**
 * Normalize one tool call's arguments onto its canonical schema keys.
 *
 * Returns the canonical object plus the alias trail on success, or a structured
 * conflict — never a partially coalesced object — on disagreement.
 */
export function coalesceToolArguments(
  toolName: string,
  args: unknown,
  options?: ToolArgumentCoalesceOptions
): ToolArgumentCoalesceResult {
  const schema = options?.inputSchema ?? resolveSchema(toolName, options)
  const declared = declaredKeysFromSchema(schema)

  if (!isRecord(args) || !declared) {
    return {
      ok: true,
      toolName,
      arguments: args,
      originalArguments: args,
      aliasesApplied: [],
      schemaResolved: Boolean(declared)
    }
  }

  const outcome = coalesceRecord(toolName, args, declared, '')

  // A gateway wrapper carries a second, nested tool call. Normalize the target
  // arguments against the TARGET's schema; the wrapper contract stays exact.
  if (stripToolNamespace(toolName) === CAPABILITY_INVOKE_TOOL_NAME) {
    const targetName = outcome.arguments.name
    const targetArguments = outcome.arguments.arguments
    if (typeof targetName === 'string' && targetName.trim() && isRecord(targetArguments)) {
      const targetDeclared = declaredKeysFromSchema(resolveSchema(targetName.trim(), options))
      if (targetDeclared) {
        const nested = coalesceRecord(
          targetName.trim(),
          targetArguments,
          targetDeclared,
          'arguments/'
        )
        outcome.conflicts.push(...nested.conflicts)
        if (nested.conflicts.length === 0) {
          outcome.arguments.arguments = nested.arguments
          outcome.applied.push(...nested.applied)
        }
      }
    }
  }

  if (outcome.conflicts.length > 0) {
    return {
      ok: false,
      code: 'ambiguous_argument_alias',
      toolName,
      message: conflictMessage(outcome.conflicts),
      conflicts: outcome.conflicts,
      originalArguments: args
    }
  }

  return {
    ok: true,
    toolName,
    arguments: outcome.arguments,
    originalArguments: args,
    aliasesApplied: outcome.applied,
    schemaResolved: true
  }
}

/** Gateway call site helper: same normalizer, named for the wrapper it guards. */
export function coalesceCapabilityInvokeArguments(
  args: unknown,
  options?: ToolArgumentCoalesceOptions
): ToolArgumentCoalesceResult {
  return coalesceToolArguments(CAPABILITY_INVOKE_TOOL_NAME, args, options)
}
