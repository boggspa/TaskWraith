import { isReadOnlyGitShellCommand, shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'
import { isInspectionShellCommand } from './ShellCommandTierPolicy'
import { isReadOnlyShellCommand } from './grok/GrokReadOnlyShell'

export type PromptFreeReadOnlyShellReason = 'readonly_shell' | 'inspection_shell'

/**
 * Canonical prompt-free shell proof used by both approval gates.
 *
 * The narrow Git classifier retains its distinct audit reason. Everything else
 * must pass either the strictly screened single-command inspection classifier
 * or the hardened multi-segment read-only shell parser. Unknown commands,
 * writes, process execution, unsafe redirects, and dynamic shell syntax fail
 * closed to the normal permission decision.
 */
export function promptFreeReadOnlyShellReason(
  rawCommand: unknown
): PromptFreeReadOnlyShellReason | null {
  const command = shellCommandFromRawCommand(rawCommand)
  if (command === null) return null
  if (isReadOnlyGitShellCommand(command)) return 'readonly_shell'
  if (isInspectionShellCommand(command) || isReadOnlyShellCommand(command)) {
    return 'inspection_shell'
  }
  return null
}

export function isPromptFreeReadOnlyShellCommand(rawCommand: unknown): boolean {
  return promptFreeReadOnlyShellReason(rawCommand) !== null
}
