import { isAbsolute, parse, resolve } from 'path'
import type { WorkspaceRecord } from './store/types'

const MAX_WORKSPACE_PATH_LENGTH = 32_768

export interface WorkspaceTargetBinding {
  readonly workspaceId: string
  readonly workspacePath: string
}

export interface PinnedWorkspaceTargetAuthorityInput {
  readonly workspace: Pick<WorkspaceRecord, 'id' | 'path' | 'realPath'>
  readonly task: WorkspaceTargetBinding
  readonly chat: WorkspaceTargetBinding
  readonly workflow?: WorkspaceTargetBinding | null
  /** Lexical normalization only. This dependency must not resolve symlinks. */
  readonly canonicalPath: (value: string) => string
  /**
   * Resolve the path as it exists now and reject unless it is a directory.
   * The returned value must be its canonical filesystem realpath.
   */
  readonly resolveRealDirectory: (value: string) => string
}

/**
 * Verify a main-owned workspace target immediately before dispatch.
 *
 * Lexical workspace identity remains unchanged for grants and persisted chat
 * bindings. The returned real path is the separately pinned execution target.
 */
export function assertPinnedWorkspaceTarget(input: PinnedWorkspaceTargetAuthorityInput): string {
  const workspaceId = nonEmptyText(input.workspace.id, 'workspace id')
  assertBindingId(input.task, workspaceId, 'task')
  assertBindingId(input.chat, workspaceId, 'chat')
  if (input.workflow) assertBindingId(input.workflow, workspaceId, 'workflow')

  const workspacePath = canonicalLexicalPath(
    input.workspace.path,
    input.canonicalPath,
    'workspace path'
  )
  assertBindingPath(input.task, workspacePath, input.canonicalPath, 'task')
  assertBindingPath(input.chat, workspacePath, input.canonicalPath, 'chat')
  if (input.workflow) {
    assertBindingPath(input.workflow, workspacePath, input.canonicalPath, 'workflow')
  }

  const pinnedRealPath = canonicalRealDirectoryPath(
    input.workspace.realPath,
    'workspace real-path pin'
  )
  let currentRealPath: string
  try {
    currentRealPath = canonicalRealDirectoryPath(
      input.resolveRealDirectory(input.workspace.path),
      'current workspace real path'
    )
  } catch (error) {
    throw new Error('Workspace target is unavailable or is not a directory.', {
      cause: error
    })
  }
  if (currentRealPath !== pinnedRealPath) {
    throw new Error('Workspace target no longer matches its main-owned real-path pin.')
  }
  return pinnedRealPath
}

function assertBindingId(
  binding: WorkspaceTargetBinding,
  workspaceId: string,
  label: string
): void {
  if (nonEmptyText(binding.workspaceId, `${label} workspace id`) !== workspaceId) {
    throw new Error(`${label} workspace id does not match the registered workspace.`)
  }
}

function assertBindingPath(
  binding: WorkspaceTargetBinding,
  workspacePath: string,
  canonicalPath: (value: string) => string,
  label: string
): void {
  if (
    canonicalLexicalPath(binding.workspacePath, canonicalPath, `${label} workspace path`) !==
    workspacePath
  ) {
    throw new Error(`${label} workspace path does not match the registered workspace.`)
  }
}

function canonicalLexicalPath(
  value: unknown,
  canonicalPath: (value: string) => string,
  label: string
): string {
  const text = nonEmptyText(value, label)
  let canonical: string
  try {
    canonical = canonicalPath(text)
  } catch (error) {
    throw new Error(`${label} cannot be canonicalized.`, { cause: error })
  }
  return canonicalRealDirectoryPath(canonical, label)
}

function canonicalRealDirectoryPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORKSPACE_PATH_LENGTH ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    parse(value).root === value
  ) {
    throw new Error(`${label} must be a bounded canonical non-root absolute path.`)
  }
  return value
}

function nonEmptyText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORKSPACE_PATH_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a bounded non-empty string.`)
  }
  return value
}
