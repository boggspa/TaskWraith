import {
  canonicalTaskWraithToolName,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from './taskWraithMcpCatalog'
import {
  PROVIDER_ACTION_ADAPTERS,
  TASKWRAITH_TOOL_ACTIONS,
  compactProviderActionIdentifier,
  resolveCatalogActionStrict,
  resolveProviderActionStrict,
  resolveProviderNativeActionForDisplay,
  resolveProviderNativeActionStrict,
  type ProviderNativeActionContext,
  type StrictProviderActionResolution
} from './providerActionTaxonomy'
import type { AgenticServiceId, ProviderId } from '../main/store/types'

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
  return compactProviderActionIdentifier(toolName)
}

/** Strip TaskWraith / MCP broker namespace prefixes from a tool name. */
export function stripToolNamespace(toolName: string): string {
  const normalized = String(toolName || '')
    .trim()
    .toLowerCase()
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
 * Historical telemetry/display aliases that predate the per-adapter taxonomy.
 * This table is deliberately permissive and MUST NOT be used for execution or
 * preflight. Strict callers use `resolveStrictProviderToolAction` below.
 */
const HISTORICAL_DISPLAY_ALIAS_TO_CATALOG_TOOL = {
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
  viewfile: 'read_file',
  view_file: 'read_file',
  listdirectory: 'list_directory',
  listdir: 'list_directory',
  list: 'list_directory',
  ls: 'list_directory',
  openworkspacefile: 'open_workspace_file',
  // Writes / edits
  write: 'write_file',
  writefile: 'write_file',
  writetofile: 'write_file',
  create: 'write_file',
  createfile: 'write_file',
  edit: 'replace',
  editfile: 'replace',
  multiedit: 'replace',
  notebookedit: 'replace',
  replace: 'replace',
  replacefilecontent: 'replace',
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
  grep_search: 'workspace_search',
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
  // Existing raster-image inspection. Execution remains the exact broker
  // `image_view` name; these aliases only coalesce provider-native transcript
  // labels and historical telemetry onto that canonical identity.
  viewimage: 'image_view',
  imageview: 'image_view',
  inspectimage: 'image_view',
  openimage: 'image_view',
  readimage: 'image_view',
  displayimage: 'image_view',
  // Todos (Cursor createPlan stays non-catalog; todo_write is catalog)
  todo: 'todo_write',
  todowrite: 'todo_write'
} as const satisfies Readonly<Record<string, TaskWraithMcpToolName>>

/**
 * Backward-compatible display projection. Provider declarations are the
 * authority; the historical tail only keeps old transcripts legible. Building
 * the projection fails fast if two adapters ever give the same compact alias
 * different catalog meanings.
 */
function buildDisplayAliasProjection(): Readonly<Record<string, TaskWraithMcpToolName>> {
  const aliases: Record<string, TaskWraithMcpToolName> = {
    ...HISTORICAL_DISPLAY_ALIAS_TO_CATALOG_TOOL
  }
  for (const declaration of Object.values(PROVIDER_ACTION_ADAPTERS)) {
    for (const [actionIds, mappings] of [
      [declaration.declaredNativeActions, declaration.nativeActionMappings],
      [declaration.declaredDeniedNativeActions, declaration.deniedNativeActionMappings]
    ] as const) {
      for (const actionId of actionIds) {
        const mapping = mappings[actionId]
        for (const alias of mapping.aliases) {
          const compact = compactToolIdentifier(alias)
          const prior = aliases[compact]
          if (prior && prior !== mapping.catalogTool) {
            throw new TypeError(
              `Provider display alias ${alias} maps to both ${prior} and ${mapping.catalogTool}.`
            )
          }
          aliases[compact] = mapping.catalogTool
        }
      }
    }
  }
  return Object.freeze(aliases)
}

/** @deprecated Display/history compatibility only; never execution authority. */
export const NATIVE_ALIAS_TO_CATALOG_TOOL = buildDisplayAliasProjection()

/** Catalog tools whose mutations should count as file edits in run summaries. */
export const CATALOG_FILE_EDIT_TOOL_NAMES: ReadonlySet<TaskWraithMcpToolName> = new Set(
  TASKWRAITH_MCP_TOOLS.filter(
    (toolName) => TASKWRAITH_TOOL_ACTIONS[toolName].operation === 'workspace.mutate'
  )
)

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
 * Provider-aware strict resolvers for execution and preflight boundaries.
 * Unlike the display helpers above, these never consult the historical global
 * alias projection and return a typed deny for an undeclared action.
 */
export function resolveStrictCatalogToolAction(
  rawToolName: string
): StrictProviderActionResolution {
  return resolveCatalogActionStrict(rawToolName)
}

export function resolveStrictProviderToolAction(
  provider: ProviderId,
  rawToolName: string
): StrictProviderActionResolution {
  return resolveProviderActionStrict(provider, rawToolName)
}

export function resolveStrictProviderNativeToolAction(
  provider: ProviderId,
  rawToolName: string,
  context?: ProviderNativeActionContext
): StrictProviderActionResolution {
  return resolveProviderNativeActionStrict(provider, rawToolName, context)
}

export function resolveProviderNativeToolForDisplay(
  provider: ProviderId,
  rawToolName: string
): TaskWraithMcpToolName | null {
  return resolveProviderNativeActionForDisplay(provider, rawToolName)?.catalogTool ?? null
}

/**
 * Agentic-service lookup for an already-canonical catalog name. The typed
 * boundary cannot accept an unknown label; display/history callers have a
 * separately named permissive helper below.
 */
export function catalogToolAgenticService(toolName: TaskWraithMcpToolName): AgenticServiceId {
  return TASKWRAITH_TOOL_ACTIONS[toolName].service
}

/** Historical/display-only fallback for labels outside the executable catalog. */
export function catalogToolAgenticServiceForDisplay(toolName: string): AgenticServiceId {
  return isCatalogToolName(toolName) ? catalogToolAgenticService(toolName) : 'mcpTools'
}

export function catalogToolAgenticServiceForRawName(rawToolName: string): AgenticServiceId | null {
  const catalog = resolveCatalogToolName(rawToolName)
  return catalog ? catalogToolAgenticService(catalog) : null
}

export function catalogToolOperationCategory(rawToolName: string): ToolOperationCategory {
  const catalog = resolveCatalogToolName(rawToolName)
  if (!catalog) return 'unknown'
  const action = TASKWRAITH_TOOL_ACTIONS[catalog]
  const operation = action.operation
  // `workspace.read` is a PERMISSION/AUDIT class, not a presentation class:
  // read_file, git_status, git_log, github_pr_view and evidence reads all share
  // it because they all read workspace state without mutating it. Only the
  // file-oriented owner may collapse to the `read_file` category, which
  // downstream treats as "this tool read a FILE" — it drives the transcript
  // label and the row icon.
  //
  // Collapsing every workspace.read tool here made `git_status` render as
  // "Read file" in the transcript (ToolParser.getToolCategory -> 'read' ->
  // getToolDisplayName's `case 'read'`), silently overriding the curated
  // `git_status: 'Git status'` label in ToolDisplayNames. The intent behind the
  // taxonomy entry was that git status needs no approval at ANY posture — which
  // was already true and shipped 2026-07-25 via the EXPLICIT
  // MCP_AUTO_ALLOWED_TOOLS allowlist (git_status/git_diff/git_log in;
  // git_show/git_blame deliberately gated). Permission availability and
  // presentation class are different axes; do not re-couple them.
  //
  // Non-file owners return 'unknown' so the legacy name-based rules and the
  // curated label table keep resolving them, which is what they did correctly
  // before the taxonomy landed.
  if (operation === 'workspace.read') {
    return action.dispatchOwner === 'workspace-tools' ? 'read_file' : 'unknown'
  }
  if (operation === 'workspace.mutate') return 'edit_file'
  // Same axis confusion as workspace.read above: `network.read` is shared by
  // web_search/web_fetch (genuinely searches) and github_ci_status (a status
  // read that rendered as "Searched"). Only the owners whose tools ARE searches
  // may collapse to the `search` presentation category.
  if (operation === 'workspace.search') {
    return action.dispatchOwner === 'workspace-tools' ? 'search' : 'unknown'
  }
  if (operation === 'network.read') {
    return action.dispatchOwner === 'web-tools' ? 'search' : 'unknown'
  }
  if (operation === 'shell.execute') return 'shell'
  // No catalog tool resolves to 'update_topic' (that operation category is
  // produced by non-tool run events, e.g. topic/title changes), so there is no
  // reachable branch for it here. Other explicitly declared operations are not
  // legacy run-summary categories and intentionally render as `unknown`.
  return 'unknown'
}

export function isCatalogFileEditTool(rawToolName: string): boolean {
  const catalog = resolveCatalogToolName(rawToolName)
  if (!catalog) return false
  return CATALOG_FILE_EDIT_TOOL_NAMES.has(catalog)
}

export function isWriteLikeCatalogTool(rawToolName: string): boolean {
  return isCatalogFileEditTool(rawToolName)
}
