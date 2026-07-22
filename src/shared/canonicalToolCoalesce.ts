import {
  canonicalTaskWraithToolName,
  MEDIA_EDITING_TOOLS,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../main/TaskWraithMcpTools'
import type { AgenticServiceId } from '../main/store/types'

function isCatalogToolName(value: string): value is TaskWraithMcpToolName {
  return (TASKWRAITH_MCP_TOOLS as readonly string[]).includes(value)
}

/**
 * Shared provider-native → TaskWraith catalog coalescing.
 *
 * Settings → Automation → Agentic services lists one row per TaskWraith MCP
 * tool (`SettingsPanel.tsx` / `TASKWRAITH_MCP_TOOLS`). Provider-native names
 * (`Shell`, `edit_file`, `search_replace`, …) should resolve to that same
 * catalog name before policy, workspace containment, diff stats, or display
 * normalizers run — one choke point, no fifth copy of the alias tables.
 */

export type ToolOperationCategory =
  | 'update_topic'
  | 'read_file'
  | 'edit_file'
  | 'search'
  | 'shell'
  | 'unknown'

/** Lowercase alphanumeric compact form — matches NativeProviderToolContainment. */
export function compactToolIdentifier(toolName: string): string {
  return String(toolName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/** Strip TaskWraith / MCP broker namespace prefixes from a tool name. */
export function stripToolNamespace(toolName: string): string {
  let normalized = String(toolName || '').trim().toLowerCase()
  if (!normalized) return normalized

  if (normalized.startsWith('mcp__')) {
    const idx = normalized.indexOf('__', 5)
    return idx > 5 ? normalized.slice(idx + 2) : normalized.slice('mcp__'.length)
  }
  if (normalized.startsWith('mcp_') && !normalized.startsWith('mcp__')) {
    const knownServerPrefixes = [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-',
      'taskwraith-broker__',
      'taskwraith_broker__',
      'taskwraith-broker_',
      'taskwraith_broker_',
      'taskwraith-broker-',
      'taskwraith_broker-'
    ]
    for (const prefix of knownServerPrefixes) {
      if (normalized.startsWith(prefix)) {
        return normalized.slice(prefix.length)
      }
    }
  }
  if (normalized.startsWith('taskwraith-broker__')) {
    return normalized.slice('taskwraith-broker__'.length)
  }
  if (normalized.startsWith('taskwraith_broker__')) {
    return normalized.slice('taskwraith_broker__'.length)
  }
  if (normalized.startsWith('taskwraith-broker_')) {
    return normalized.slice('taskwraith-broker_'.length)
  }
  if (normalized.startsWith('taskwraith_broker_')) {
    return normalized.slice('taskwraith_broker_'.length)
  }
  if (normalized.startsWith('taskwraith__')) return normalized.slice('taskwraith__'.length)
  if (normalized.startsWith('taskwraith_')) return normalized.slice('taskwraith_'.length)
  return normalized
}

/**
 * Provider-native aliases → Settings catalog tool names.
 * Keys are compact identifiers (see `compactToolIdentifier`).
 */
export const NATIVE_ALIAS_TO_CATALOG_TOOL: Readonly<Record<string, TaskWraithMcpToolName>> = {
  // Shell / runtime
  shell: 'run_shell_command',
  bash: 'run_shell_command',
  runshellcommand: 'run_shell_command',
  runcommand: 'run_shell_command',
  runterminalcommand: 'run_shell_command',
  runterminal: 'run_shell_command',
  terminal: 'run_shell_command',
  run: 'run_shell_command',
  execcommand: 'run_shell_command',
  // Reads / listings
  read: 'read_file',
  readfile: 'read_file',
  listdirectory: 'list_directory',
  listdir: 'list_directory',
  list: 'list_directory',
  ls: 'list_directory',
  openworkspacefile: 'open_workspace_file',
  // Writes / edits
  write: 'write_file',
  writefile: 'write_file',
  create: 'write_file',
  createfile: 'write_file',
  edit: 'replace',
  editfile: 'replace',
  multiedit: 'replace',
  notebookedit: 'replace',
  replace: 'replace',
  strreplace: 'replace',
  strreplaceeditor: 'replace',
  searchreplace: 'replace',
  // Paths
  delete: 'delete_path',
  deletefile: 'delete_path',
  deletepath: 'delete_path',
  remove: 'delete_path',
  movefile: 'move_path',
  movepath: 'move_path',
  renamefile: 'rename_path',
  renamepath: 'rename_path',
  createdirectory: 'create_directory',
  applypatch: 'apply_patch',
  patch: 'apply_patch',
  // Search / discovery
  glob: 'find_files',
  findfiles: 'find_files',
  grep: 'workspace_search',
  grepsearch: 'workspace_search',
  search: 'workspace_search',
  workspacesearch: 'workspace_search',
  workspacesymbols: 'workspace_symbols',
  filesearch: 'workspace_search',
  rg: 'workspace_search',
  codesearch: 'workspace_search',
  codebasesearch: 'workspace_search',
  semanticsearch: 'workspace_search',
  googlewebsearch: 'web_search',
  websearch: 'web_search',
  webfetch: 'web_fetch',
  fetch: 'web_fetch',
  // Diagnostics / web
  readlints: 'get_diagnostics',
  getdiagnostics: 'get_diagnostics',
  // Todos (Cursor createPlan stays non-catalog; todo_write is catalog)
  todo: 'todo_write',
  todowrite: 'todo_write'
}

/** Catalog tools whose mutations should count as file edits in run summaries. */
export const CATALOG_FILE_EDIT_TOOL_NAMES: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'apply_patch',
  'git_stage',
  'git_commit'
])

const READ_OPERATION_TOOLS: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'read_file',
  'list_directory',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'open_workspace_file',
  'document_extract_text',
  'document_ocr_image'
])

const SEARCH_OPERATION_TOOLS: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'web_search',
  'web_fetch',
  'tw_recall_find',
  'scope_radar',
  'repo_convention_scan'
])

const SHELL_OPERATION_TOOLS: ReadonlySet<TaskWraithMcpToolName> = new Set([
  'run_shell_command',
  'run_task',
  'start_background_process',
  'list_background_processes',
  'read_background_process',
  'kill_background_process',
  'get_diagnostics',
  'launch_start',
  'launch_stop'
])

/**
 * Resolve any provider-native or namespaced tool label to the Settings catalog
 * name when possible; otherwise return the normalized snake-ish label from
 * `canonicalTaskWraithToolName`.
 */
export function resolveCanonicalToolName(rawToolName: string): string {
  const brokerCanonical = canonicalTaskWraithToolName(rawToolName)
  if (isCatalogToolName(brokerCanonical)) return brokerCanonical

  const compact = compactToolIdentifier(stripToolNamespace(rawToolName))
  const alias = compact ? NATIVE_ALIAS_TO_CATALOG_TOOL[compact] : undefined
  if (alias) return alias

  return brokerCanonical
}

/** Resolve to a catalog tool only when the name maps to `TASKWRAITH_MCP_TOOLS`. */
export function resolveCatalogToolName(rawToolName: string): TaskWraithMcpToolName | null {
  const canonical = resolveCanonicalToolName(rawToolName)
  return isCatalogToolName(canonical) ? canonical : null
}

/**
 * Agentic-service bucket for a tool name — the SINGLE canonical policy ladder
 * (WS-C). This is the one source of truth consumed by the runtime security gate
 * (`NativeApprovalPolicy.taskWraithToolAgenticService`), the Settings policy chip
 * (`SettingsPanel.inferMcpPolicyKey`), and display/audit normalizers, so the
 * bucket a tool lands in can never drift between where it is *shown* and where it
 * is *enforced*.
 *
 * Accepts any string so both catalog names and already-canonicalized native
 * names resolve identically. The ladder is exact-name based; there is no
 * substring/`startsWith` matching because the only catalog tools containing
 * `import`/`dispatch` are `creative_*` (audited via their own approvals), and a
 * loose substring branch would risk silently reclassifying future tools.
 *
 * Security-load-bearing ordering (mirrors the historical gate):
 *  - shell-class (run/task/background/diagnostics/launch) → `shellCommands`
 *  - git push / PR → `externalPublish` (non-grantable)
 *  - audio/video media → `mediaEditing` (dedicated grant bucket + audit)
 *  - file mutations / staged git → `fileChanges`
 *  - sub-thread delegation → `subThreadDelegation`
 *  - canvas click/fill/sketch mutate → `canvasInteraction`
 *  - canvas eval (RCE) → `canvasEval` (signed-elevated, never auto-allowed)
 *  - cross-thread recall reads → `crossThreadRead`
 *  - everything else → `mcpTools`
 */
export function catalogToolAgenticService(toolName: string): AgenticServiceId {
  if (
    toolName === 'run_shell_command' ||
    toolName === 'run_task' ||
    toolName === 'start_background_process' ||
    toolName === 'kill_background_process' ||
    toolName === 'get_diagnostics' ||
    toolName === 'launch_start' ||
    toolName === 'launch_stop'
  ) {
    return 'shellCommands'
  }
  if (toolName === 'git_push' || toolName === 'git_create_pr') return 'externalPublish'
  if (MEDIA_EDITING_TOOLS.has(toolName)) return 'mediaEditing'
  if (
    toolName === 'write_file' ||
    toolName === 'replace' ||
    toolName === 'create_directory' ||
    toolName === 'delete_path' ||
    toolName === 'move_path' ||
    toolName === 'rename_path' ||
    toolName === 'apply_patch' ||
    toolName === 'git_stage' ||
    toolName === 'git_commit'
  ) {
    return 'fileChanges'
  }
  if (toolName === 'delegate_to_subthread' || toolName === 'cancel_subthread') {
    return 'subThreadDelegation'
  }
  if (
    toolName === 'canvas_click' ||
    toolName === 'canvas_fill' ||
    toolName === 'canvas_sketch_update'
  ) {
    return 'canvasInteraction'
  }
  if (toolName === 'canvas_eval') return 'canvasEval'
  if (
    toolName === 'tw_recall_find' ||
    toolName === 'tw_recall_read' ||
    toolName === 'tw_recall_read_events'
  ) {
    return 'crossThreadRead'
  }
  return 'mcpTools'
}

export function catalogToolAgenticServiceForRawName(rawToolName: string): AgenticServiceId | null {
  const catalog = resolveCatalogToolName(rawToolName)
  return catalog ? catalogToolAgenticService(catalog) : null
}

export function catalogToolOperationCategory(rawToolName: string): ToolOperationCategory {
  const catalog = resolveCatalogToolName(rawToolName)
  if (!catalog) return 'unknown'
  if (READ_OPERATION_TOOLS.has(catalog)) return 'read_file'
  if (CATALOG_FILE_EDIT_TOOL_NAMES.has(catalog)) return 'edit_file'
  if (SEARCH_OPERATION_TOOLS.has(catalog)) return 'search'
  if (SHELL_OPERATION_TOOLS.has(catalog)) return 'shell'
  // No catalog tool resolves to 'update_topic' (that operation category is
  // produced by non-tool run events, e.g. topic/title changes), so there is no
  // reachable branch for it here — the union member is retained for consumers.
  return 'unknown'
}

export function isCatalogFileEditTool(rawToolName: string): boolean {
  const catalog = resolveCatalogToolName(rawToolName)
  if (!catalog) {
    const compact = compactToolIdentifier(stripToolNamespace(rawToolName))
    return (
      compact === 'editfile' ||
      compact === 'createfile' ||
      compact === 'deletefile' ||
      compact === 'patch'
    )
  }
  return CATALOG_FILE_EDIT_TOOL_NAMES.has(catalog)
}

export function isWriteLikeCatalogTool(rawToolName: string): boolean {
  return isCatalogFileEditTool(rawToolName)
}
