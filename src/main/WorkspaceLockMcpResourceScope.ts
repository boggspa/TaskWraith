import { isAbsolute, resolve } from 'node:path'

/**
 * Returns one exact resource only when the mutation has a single path role.
 * Multi-path and repository/runtime tools deliberately return undefined so an
 * Ensemble writer needs workspace-wide scope instead of validating one path
 * and silently mutating another.
 */
export function workspaceLockMcpResourcePath(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  workspacePath: string
): string | undefined {
  if (
    toolName !== 'write_file' &&
    toolName !== 'replace' &&
    toolName !== 'create_directory' &&
    toolName !== 'delete_path'
  ) {
    return undefined
  }
  const raw = firstNonEmptyString(args.path, args.file_path)
  if (!raw) return undefined
  return isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw)
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (value.trim()) return value
  }
  return null
}
