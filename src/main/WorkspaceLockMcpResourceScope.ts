import { isAbsolute, resolve } from 'node:path'

/**
 * Legacy single-target hint for approval/scope presentation. Multi-target and
 * repository/runtime tools deliberately return undefined: authoritative lock
 * admission derives their complete atomic file/hunk target set from the tool
 * arguments and never interprets an absent hint as broader scope.
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
