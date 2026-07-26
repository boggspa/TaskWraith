import type { AgenticServicePolicy } from '../store/types'

/**
 * The already-verified permission fields that can narrow Pi's native tool
 * allowlist. Signature verification belongs at the main run boundary; this
 * helper only consumes that trusted projection and never treats it as a source
 * of elevation.
 */
export interface PiNativeToolEffectivePermissions {
  readonly readOnly?: boolean
  readonly agenticServices?: Readonly<{
    readonly shellCommands?: AgenticServicePolicy
    readonly fileChanges?: AgenticServicePolicy
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
 * Resolve Pi's launch-time native-tool posture without ever widening it.
 *
 * Pi has no per-tool approval bridge and runs with `--no-approve`, so write
 * tools are present only for the one historically write-capable mode and only
 * while the signed effective posture leaves both relevant services enabled.
 * Missing posture fields preserve the approval-mode baseline; explicit
 * read-only/deny fields can only downgrade it.
 */
export function resolvePiNativeToolPosture(input: PiNativeToolPostureInput): PiNativeToolPosture {
  const permissions = input.effectivePermissions
  const writeCapable =
    input.approvalMode === 'default' &&
    permissions?.readOnly !== true &&
    permissions?.agenticServices?.shellCommands !== 'deny' &&
    permissions?.agenticServices?.fileChanges !== 'deny'

  return Object.freeze({
    writeCapable,
    effectiveMode: writeCapable ? 'default' : 'plan'
  })
}
