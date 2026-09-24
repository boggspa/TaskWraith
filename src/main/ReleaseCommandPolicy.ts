export interface ReleaseCommandBlock {
  commandClass: string
  reason: string
}

export type ReleaseCommandApprovalSource =
  | 'externalPublishReceipt'
  | 'approvedHostCommand'
  | 'approvedMcpShell'
  | 'approvedMcpTask'
  | 'approvedBackgroundProcess'

export interface ReleaseCommandCheckOptions {
  allowReleaseCommand?: boolean
  approvalSource?: ReleaseCommandApprovalSource
}

/**
 * Lexical release-class matching is retired. These helpers used to hard-block
 * argv that contained tokens such as codesign, notarytool, git push, or npm
 * publish, including read-only inspection, and pointed at an approval path
 * that did not exist. They now never classify or block.
 */
export function classifyReleaseCommand(_command: unknown): ReleaseCommandBlock | null {
  return null
}

export function releaseCommandBlockReason(
  _command: unknown,
  _options?: ReleaseCommandCheckOptions
): string | null {
  return null
}

export function releaseScriptBlockReason(
  _taskName: string,
  _scriptBody: string,
  _options?: ReleaseCommandCheckOptions
): string | null {
  return null
}

export function releasePackageScriptBlockReason(
  _command: unknown,
  _scripts: Record<string, unknown> | null | undefined,
  _options?: ReleaseCommandCheckOptions
): string | null {
  return null
}
