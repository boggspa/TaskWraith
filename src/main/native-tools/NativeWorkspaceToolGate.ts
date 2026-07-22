import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import {
  catalogToolAgenticService,
  resolveCatalogToolName
} from '../../shared/canonicalToolCoalesce'
import { resolveWorkspaceDirectory, resolveWorkspaceTarget } from '../PathScope'
import type { AgenticServiceId } from '../store/types'

export type NativeWorkspaceToolAccess = 'read' | 'write' | 'shell'

export type NativeWorkspaceToolPreflight =
  | {
      kind: 'not_applicable'
      canonicalTool: string | null
      source: 'taskwraith' | 'unknown'
    }
  | {
      kind: 'allow'
      canonicalTool: string
      source: 'native'
      service: AgenticServiceId
      access: NativeWorkspaceToolAccess
      checkedPaths: string[]
      normalizedCwd?: string
      requiresRuntimeSandbox: boolean
    }
  | {
      kind: 'deny'
      canonicalTool: string | null
      source: 'native'
      reason: string
      checkedPaths: string[]
      requiresRuntimeSandbox: boolean
    }

export interface NativeWorkspaceToolPreflightInput {
  toolName?: string | null
  toolKind?: string | null
  rawToolCall?: unknown
  workspacePath?: string | null
  /**
   * True only when the provider's native shell executes inside a hard runtime
   * boundary whose writable/readable roots are the active workspace. A cwd
   * check alone is not containment: `cat /etc/passwd` still escapes it.
   */
  runtimeSandboxed?: boolean
}

const READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'get_diagnostics'
])

const WRITE_TOOLS = new Set([
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'apply_patch'
])

const OPTIONAL_PATH_TOOLS = new Set([
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'get_diagnostics'
])

const MULTI_PATH_TOOLS = new Set(['move_path', 'rename_path'])

const PATH_FIELDS = new Set([
  'path',
  'file',
  'filename',
  'fileName',
  'filePath',
  'file_path',
  'notebookPath',
  'notebook_path',
  'directory',
  'dir',
  'target',
  'targetPath',
  'target_path',
  'targetFile',
  'target_file',
  'targetFilePath',
  'target_file_path',
  'source',
  'sourcePath',
  'source_path',
  'destination',
  'destinationPath',
  'destination_path',
  'from',
  'fromPath',
  'from_path',
  'to',
  'toPath',
  'to_path',
  'oldPath',
  'old_path',
  'oldFilePath',
  'old_file_path',
  'newPath',
  'new_path',
  'newFilePath',
  'new_file_path'
])

const NESTED_ARGUMENT_FIELDS = ['rawInput', 'input', 'parameters', 'arguments', 'args'] as const
const BROKER_PREFIXES = [
  'mcp__',
  'mcp_taskwraith',
  'taskwraith__',
  'taskwraith_',
  'taskwraith-',
  'taskwraith-grok__',
  'taskwraith-broker__'
] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function argumentRoots(rawToolCall: unknown): Record<string, unknown>[] {
  const root = asRecord(rawToolCall)
  if (!root) return []
  const roots = [root]
  for (const key of NESTED_ARGUMENT_FIELDS) {
    const nested = asRecord(root[key])
    if (nested) roots.push(nested)
  }
  return roots
}

function brokerQualifiedToolName(input: NativeWorkspaceToolPreflightInput): boolean {
  const roots = argumentRoots(input.rawToolCall)
  const candidates: unknown[] = [input.toolName]
  for (const root of roots) candidates.push(root.tool_name, root.toolName, root.name)
  return candidates.some((candidate) => {
    const normalized = nonEmptyString(candidate)?.toLowerCase()
    return Boolean(
      normalized && BROKER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    )
  })
}

function canonicalFromHumanTitle(title: string): string | null {
  const normalized = title.trim().toLowerCase()
  const prefixes: Array<[RegExp, string]> = [
    [/^(?:read|open)(?:\s+file)?\b/, 'read_file'],
    [/^(?:write|create)(?:\s+file)?\b/, 'write_file'],
    [/^(?:edit|replace|modify)(?:\s+file)?\b/, 'replace'],
    [/^(?:delete|remove)(?:\s+(?:file|path))?\b/, 'delete_path'],
    [/^move(?:\s+(?:file|path))?\b/, 'move_path'],
    [/^rename(?:\s+(?:file|path))?\b/, 'rename_path'],
    [/^(?:list|ls)(?:\s+(?:directory|files?))?\b/, 'list_directory'],
    [/^(?:glob|find)(?:\s+files?)?\b/, 'find_files'],
    [/^(?:grep|search)(?:\s+(?:files?|workspace))?\b/, 'workspace_search'],
    [/^(?:apply\s+patch|patch)\b/, 'apply_patch'],
    [/^(?:bash|shell|run\s+(?:terminal\s+)?command|terminal)\b/, 'run_shell_command']
  ]
  return prefixes.find(([pattern]) => pattern.test(normalized))?.[1] || null
}

function canonicalFromKind(toolKind: string | null | undefined): string | null {
  switch (String(toolKind || '').trim().toLowerCase()) {
    case 'read':
      return 'read_file'
    case 'edit':
    case 'write':
    case 'create':
      return 'replace'
    case 'delete':
      return 'delete_path'
    case 'move':
      return 'move_path'
    case 'search':
      return 'workspace_search'
    case 'execute':
      return 'run_shell_command'
    default:
      return null
  }
}

function resolveNativeCanonicalTool(input: NativeWorkspaceToolPreflightInput): string | null {
  const roots = argumentRoots(input.rawToolCall)
  const candidates: unknown[] = []
  for (const root of roots) candidates.push(root.tool_name, root.toolName, root.name)
  candidates.push(input.toolName)
  for (const candidate of candidates) {
    const value = nonEmptyString(candidate)
    if (!value) continue
    const catalog = resolveCatalogToolName(value)
    if (catalog) return catalog
  }
  const title = nonEmptyString(input.toolName)
  return (title && canonicalFromHumanTitle(title)) || canonicalFromKind(input.toolKind)
}

function collectPathArguments(rawToolCall: unknown): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown): void => {
    const path = nonEmptyString(value)
    if (!path || seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }
  for (const root of argumentRoots(rawToolCall)) {
    for (const [key, value] of Object.entries(root)) {
      if (PATH_FIELDS.has(key)) add(value)
      if ((key === 'paths' || key === 'files') && Array.isArray(value)) {
        for (const entry of value) add(entry)
      }
      if (key === 'changes' && Array.isArray(value)) {
        for (const change of value) {
          const record = asRecord(change)
          if (!record) continue
          for (const [changeKey, changeValue] of Object.entries(record)) {
            if (PATH_FIELDS.has(changeKey)) add(changeValue)
          }
        }
      }
    }
  }
  return paths
}

function patchPaths(rawToolCall: unknown): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const root of argumentRoots(rawToolCall)) {
    const patch = [root.patch, root.diff, root.input]
      .map(nonEmptyString)
      .find((value): value is string => Boolean(value && /^(?:---|\+\+\+)\s/m.test(value)))
    if (!patch) continue
    for (const line of patch.split(/\r?\n/)) {
      const match = line.match(/^(?:---|\+\+\+)\s+([^\t]+)(?:\t.*)?$/)
      if (!match) continue
      let path = match[1].trim()
      if (path === '/dev/null') continue
      if ((path.startsWith('a/') || path.startsWith('b/')) && !path.startsWith('/')) {
        path = path.slice(2)
      }
      if (path && !seen.has(path)) {
        seen.add(path)
        paths.push(path)
      }
    }
  }
  return paths
}

function requestedCwd(rawToolCall: unknown): string | null {
  for (const root of argumentRoots(rawToolCall)) {
    for (const key of ['cwd', 'workdir', 'workingDirectory', 'working_directory']) {
      const cwd = nonEmptyString(root[key])
      if (cwd) return cwd
    }
  }
  return null
}

/**
 * Re-resolve the deepest existing ancestor so an in-workspace symlink cannot
 * redirect a native path outside the workspace between lexical normalization
 * and provider execution. This is still a preflight, not a substitute for a
 * runtime sandbox against post-approval path swaps.
 */
function resolveCanonicalWorkspaceTarget(workspacePath: string, rawPath: string): string {
  const workspaceRoot = resolve(workspacePath)
  const lexicalTarget = resolveWorkspaceTarget(workspaceRoot, rawPath)
  const canonicalWorkspace = realpathSync(workspaceRoot)
  let existingAncestor = lexicalTarget
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const canonicalAncestor = realpathSync(existingAncestor)
  const canonicalTarget = resolve(canonicalAncestor, relative(existingAncestor, lexicalTarget))
  resolveWorkspaceTarget(canonicalWorkspace, canonicalTarget)
  return lexicalTarget
}

function deny(
  canonicalTool: string | null,
  reason: string,
  checkedPaths: string[] = [],
  requiresRuntimeSandbox = false
): NativeWorkspaceToolPreflight {
  return {
    kind: 'deny',
    canonicalTool,
    source: 'native',
    reason,
    checkedPaths,
    requiresRuntimeSandbox
  }
}

/**
 * Canonical pre-execution workspace check for provider-native tools.
 *
 * It deliberately does not execute or rewrite the provider tool. Adapters use
 * the result at their real pre-execution hook, then route allowed operations
 * through the ordinary ledger. TaskWraith-qualified MCP calls return
 * `not_applicable` because the broker performs its own canonical argument and
 * workspace checks.
 */
export function preflightNativeWorkspaceTool(
  input: NativeWorkspaceToolPreflightInput
): NativeWorkspaceToolPreflight {
  const canonicalTool = resolveNativeCanonicalTool(input)
  if (brokerQualifiedToolName(input)) {
    return { kind: 'not_applicable', canonicalTool, source: 'taskwraith' }
  }
  if (!canonicalTool) {
    return { kind: 'not_applicable', canonicalTool: null, source: 'unknown' }
  }
  if (
    !READ_TOOLS.has(canonicalTool) &&
    !WRITE_TOOLS.has(canonicalTool) &&
    canonicalTool !== 'run_shell_command'
  ) {
    return { kind: 'not_applicable', canonicalTool, source: 'unknown' }
  }

  const workspacePath = nonEmptyString(input.workspacePath)
  if (!workspacePath) {
    return deny(canonicalTool, 'Native workspace tools require an active workspace.')
  }

  if (canonicalTool === 'run_shell_command') {
    let normalizedCwd: string
    try {
      normalizedCwd = resolveWorkspaceDirectory(workspacePath, requestedCwd(input.rawToolCall))
    } catch {
      return deny(
        canonicalTool,
        'Native shell cwd is outside the active workspace.',
        [],
        true
      )
    }
    if (input.runtimeSandboxed !== true) {
      return deny(
        canonicalTool,
        'Native shell requires a runtime workspace sandbox; cwd validation alone cannot contain absolute paths or egress.',
        [normalizedCwd],
        true
      )
    }
    return {
      kind: 'allow',
      canonicalTool,
      source: 'native',
      service: catalogToolAgenticService(canonicalTool),
      access: 'shell',
      checkedPaths: [normalizedCwd],
      normalizedCwd,
      requiresRuntimeSandbox: true
    }
  }

  const rawPaths = collectPathArguments(input.rawToolCall)
  if (canonicalTool === 'apply_patch') rawPaths.push(...patchPaths(input.rawToolCall))
  const uniqueRawPaths = [...new Set(rawPaths)]
  if (uniqueRawPaths.length === 0 && !OPTIONAL_PATH_TOOLS.has(canonicalTool)) {
    return deny(canonicalTool, `Native ${canonicalTool} did not expose a verifiable workspace path.`)
  }
  if (MULTI_PATH_TOOLS.has(canonicalTool) && uniqueRawPaths.length < 2) {
    return deny(canonicalTool, `Native ${canonicalTool} did not expose both source and destination paths.`)
  }

  const checkedPaths: string[] = []
  try {
    for (const path of uniqueRawPaths) {
      checkedPaths.push(resolveCanonicalWorkspaceTarget(workspacePath, path))
    }
  } catch {
    return deny(
      canonicalTool,
      `Native ${canonicalTool} requested a path outside the active workspace.`,
      checkedPaths
    )
  }

  const access: NativeWorkspaceToolAccess = WRITE_TOOLS.has(canonicalTool) ? 'write' : 'read'
  return {
    kind: 'allow',
    canonicalTool,
    source: 'native',
    service: catalogToolAgenticService(canonicalTool),
    access,
    checkedPaths,
    requiresRuntimeSandbox: false
  }
}
