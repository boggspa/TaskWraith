/*
 * ExternalPathDetector — slice 5 of the external-path-redesign arc.
 *
 * Inspects a tool-call's params for filesystem paths that fall outside
 * the workspace's containment. When detected, callers (Codex/Claude/
 * Kimi registration sites in `main/index.ts`) override the generic
 * approval `actions` with the slice-4 triplet
 * (`grantExternalPathRead | grantExternalPathEdit | declineExternalPath`)
 * and stash the detected path under `preview.externalPathDetection` so
 * the renderer modal can display it prominently.
 *
 * Pure-ish: takes the values it needs as arguments, no module-level
 * singletons. Unit-tested in `ExternalPathDetector.test.ts`.
 */

import * as path from 'node:path'

/**
 * Map of tool-name lowercase → semantic category.
 * `read` = touches the file but doesn't mutate; needs READ grant.
 * `write` = mutates the file; needs EDIT grant.
 * Anything not in this map is treated as "not a file IO tool" and
 * the detector skips it entirely (e.g. shell commands, web search,
 * task tools — those have their own approval paths).
 */
const FILE_IO_TOOL_CATEGORY: Record<string, 'read' | 'write'> = {
  // Read-side
  // Provider-native aliases (Claude SDK / ACP) arrive without the
  // TaskWraith snake_case names. Keep them here so the shared approval preflight
  // cannot auto-allow an outside-workspace Read/Glob/Grep before it is classified.
  read: 'read',
  glob: 'read',
  grep: 'read',
  read_file: 'read',
  list_directory: 'read',
  find_files: 'read',
  // Write-side
  write: 'write',
  write_file: 'write',
  replace: 'write',
  create_directory: 'write',
  delete_path: 'write',
  move_path: 'write',
  rename_path: 'write',
  edit: 'write',
  edit_file: 'write',
  create_file: 'write',
  delete_file: 'write',
  multiedit: 'write',
  notebookedit: 'write',
  apply_patch: 'write',
  str_replace: 'write',
  str_replace_editor: 'write',
  strreplaceeditor: 'write'
}

/**
 * Strip `mcp__<server>__` / `taskwraith__` namespace prefixes so the
 * bare tool name can be category-looked up.
 */
function stripToolNamespace(toolName: string): string {
  const lower = (toolName || '').toLowerCase()
  if (lower.startsWith('mcp__')) {
    const idx = lower.indexOf('__', 5)
    return idx > 5 ? lower.slice(idx + 2) : lower
  }
  if (lower.startsWith('taskwraith__')) return lower.slice('taskwraith__'.length)
  return lower
}

/**
 * Inspect a params object for the conventional path-bearing fields.
 * Returns every non-empty path found, in wire-order. Relative paths are
 * resolved against the active workspace before containment checks.
 *
 * Covers three param-shape families TaskWraith's detectors see in the wild:
 *  1. Flat path fields used by most tool-call params (path, filePath,
 *     file_path, target, target_file, target_file_path).
 *  2. Codex's `item/fileChange/requestApproval` shape, which carries a
 *     `changes: [{path, kind?}]` array instead of a flat field.
 *  3. Codex's `item/.../command` shape, where the agent is asking to
 *     execute a command in a `cwd` — useful when the command would
 *     work against a directory outside the workspace.
 */
function extractPathsFromParams(params: unknown, workspacePath?: string): string[] {
  if (!params || typeof params !== 'object') return []
  const record = params as Record<string, unknown>
  const paths: string[] = []
  // (1) Flat fields. ToolParser's `getPathFromRecord` covers the same
  // set on the renderer side.
  const flatCandidates = [
    record.path,
    record.filePath,
    record.file_path,
    record.target,
    record.target_file,
    record.target_file_path,
    record.targetPath,
    record.targetFile,
    record.from,
    record.to,
    record.source,
    record.destination,
    record.sourcePath,
    record.destinationPath,
    record.fromPath,
    record.toPath,
    record.cwd,
    record.workdir
  ]
  for (const candidate of flatCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const trimmed = candidate.trim()
      if (path.isAbsolute(trimmed)) paths.push(trimmed)
      else if (workspacePath) paths.push(path.resolve(workspacePath, trimmed))
    }
  }
  // (2) Codex `item/fileChange/requestApproval` shape.
  const changes = record.changes as Array<Record<string, unknown>> | undefined
  if (Array.isArray(changes) && changes.length > 0) {
    for (const change of changes) {
      const p = change?.path
      if (typeof p === 'string' && p.trim()) {
        const trimmed = p.trim()
        if (path.isAbsolute(trimmed)) paths.push(trimmed)
        else if (workspacePath) paths.push(path.resolve(workspacePath, trimmed))
      }
    }
  }
  // (3) Nested `item.path` / `item.changes` shape (Codex wraps params
  // in an `item` object for some methods).
  const item = record.item as Record<string, unknown> | undefined
  if (item && typeof item === 'object') {
    paths.push(...extractPathsFromParams(item, workspacePath))
  }
  return paths
}

/**
 * Decide whether a path lies outside the workspace. Returns true when:
 *   - workspacePath is missing (global chat — no workspace to be inside of)
 *   - the path resolves outside `workspacePath`
 *
 * Uses path normalisation + a trailing slash check to avoid false
 * positives on prefix matches (e.g. `/Users/me/proj-2` vs `/Users/me/proj`).
 */
function isOutsideWorkspace(absolutePath: string, workspacePath?: string): boolean {
  if (!workspacePath) return true
  const normalisedWorkspace = path.resolve(workspacePath).replace(/\/+$/, '')
  const normalisedPath = path.resolve(absolutePath).replace(/\/+$/, '')
  if (normalisedPath === normalisedWorkspace) return false
  return !normalisedPath.startsWith(normalisedWorkspace + path.sep)
}

export interface ExternalPathDetection {
  needsPrompt: boolean
  path?: string
  access?: 'read' | 'write'
  basename?: string
}

/**
 * Run the detector against a tool call. Returns
 * `{ needsPrompt: true, path, access, basename }` when the call
 * references a path outside the workspace AND the tool is a
 * recognised file-IO operation. Otherwise returns
 * `{ needsPrompt: false }`.
 *
 * Callers should plumb the result into the approval payload:
 *   - Override actions with the slice-4 triplet
 *   - Set `preview.externalPathDetection = { path, basename, access }`
 *   - Optionally adjust the `title` / `body` to mention the path
 */
export function detectExternalPath(input: {
  toolName: string
  params: unknown
  workspacePath?: string
  /**
   * Codex JSON-RPC method name (e.g. `item/fileChange/requestApproval`,
   * `item/permissions/requestApproval`). When the toolName isn't in the
   * params (Codex's fileChange + command approvals don't carry a tool
   * name field), the method itself acts as a fallback category hint:
   *   - `item/fileChange/...` → 'write' (file mutation)
   * The `tool` allowlist is the primary check; this is only consulted
   * when no `toolName` matched.
   */
  method?: string
  /**
   * Existing grants for the chat (provider-agnostic). When the path
   * is already granted at the same-or-higher access level, the
   * detector returns `needsPrompt: false` so the agent proceeds
   * without re-prompting.
   */
  existingGrants?: Array<{ path: string; access: 'read' | 'write'; kind?: 'file' | 'directory' }>
}): ExternalPathDetection {
  let category = FILE_IO_TOOL_CATEGORY[stripToolNamespace(input.toolName)]
  // Method-based fallback: when the wire protocol doesn't expose a
  // toolName (Codex's fileChange + command approvals), infer category
  // from the method itself.
  if (!category && input.method) {
    const method = input.method.toLowerCase()
    if (method.includes('filechange')) category = 'write'
  }
  if (!category) return { needsPrompt: false }

  const detectedPaths = extractPathsFromParams(input.params, input.workspacePath)
  if (!detectedPaths.length) return { needsPrompt: false }

  for (const detectedPath of detectedPaths) {
    if (!isOutsideWorkspace(detectedPath, input.workspacePath)) {
      continue
    }

    // Honour existing grants — skip-prompt when the path is already
    // covered. A write-access grant covers read needs too; a read
    // grant doesn't cover write needs. `kind: file` is exact-only;
    // omitted kind is treated as directory for older grant-shaped tests.
    if (input.existingGrants?.length) {
      const matching = input.existingGrants.find((grant) => {
        if (!grant?.path) return false
        const normalisedGrantPath = path.resolve(grant.path).replace(/\/+$/, '')
        const normalisedDetectedPath = path.resolve(detectedPath).replace(/\/+$/, '')
        const coversPath =
          normalisedGrantPath === normalisedDetectedPath ||
          (grant.kind !== 'file' && normalisedDetectedPath.startsWith(normalisedGrantPath + path.sep))
        if (!coversPath) return false
        return category === 'read' || grant.access === 'write'
      })
      if (matching) continue
    }

    return {
      needsPrompt: true,
      path: detectedPath,
      access: category,
      basename: path.basename(detectedPath)
    }
  }

  return { needsPrompt: false }
}
