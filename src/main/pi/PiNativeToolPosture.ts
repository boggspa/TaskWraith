import type { AgenticServicePolicy } from '../store/types'

/**
 * The already-verified permission fields that can enable Pi's exact brokered
 * file tools. Native Pi tools stay read-only for every posture.
 */
export interface PiNativeToolEffectivePermissions {
  readonly readOnly?: boolean
  readonly agenticServices?: Readonly<{
    readonly shellCommands?: AgenticServicePolicy
    readonly fileChanges?: AgenticServicePolicy
    /** Used by Pi's optional managed Ensemble coordination extension. */
    readonly mcpTools?: AgenticServicePolicy
  }>
}

export interface PiNativeToolPostureInput {
  readonly approvalMode: string | null | undefined
  readonly effectivePermissions?: PiNativeToolEffectivePermissions | null
}

export interface PiNativeToolPosture {
  readonly writeCapable: boolean
  readonly effectiveMode: 'default' | 'plan'
}

/**
 * Resolve Pi's launch-time brokered-file posture without ever widening it.
 *
 * Pi runs native tools with `--no-approve`, so that list is always read-only.
 * The historically write-capable mode now enables only TaskWraith's exact file
 * bridge. Shell policy is irrelevant because no native shell is exposed;
 * read-only/file-change deny can still downgrade the broker surface.
 */
export function resolvePiNativeToolPosture(input: PiNativeToolPostureInput): PiNativeToolPosture {
  const permissions = input.effectivePermissions
  const writeCapable =
    input.approvalMode === 'default' &&
    permissions?.readOnly !== true &&
    permissions?.agenticServices?.fileChanges !== 'deny'

  return Object.freeze({
    writeCapable,
    effectiveMode: writeCapable ? 'default' : 'plan'
  })
}
