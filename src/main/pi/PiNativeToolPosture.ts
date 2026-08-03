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
  readonly shellCapable: boolean
  readonly effectiveMode: 'default' | 'plan'
}

/**
 * Resolve Pi's launch-time brokered-file posture without ever widening it.
 *
 * Pi runs native tools with `--no-approve`, so that list is always read-only.
 * The historically write-capable mode enables TaskWraith's exact file bridge.
 * Shell is a separate managed broker capability: native Pi shell remains
 * disabled, but a signed shell policy can expose TaskWraith run_shell_command.
 */
export function resolvePiNativeToolPosture(input: PiNativeToolPostureInput): PiNativeToolPosture {
  const permissions = input.effectivePermissions
  const managedMutationCapable = input.approvalMode === 'default' && permissions?.readOnly !== true
  const writeCapable =
    managedMutationCapable && permissions?.agenticServices?.fileChanges !== 'deny'
  const shellCapable =
    managedMutationCapable && permissions?.agenticServices?.shellCommands !== 'deny'

  return Object.freeze({
    writeCapable,
    shellCapable,
    effectiveMode: writeCapable ? 'default' : 'plan'
  })
}
