// Kimi Code native-tool policy for a human-selected Full Access run.
//
// Production Kimi seats are contained: the isolated profile statically denies
// every native fs/exec/egress/fan-out tool and routes workspace access through
// the governed TaskWraith gateway (KimiAcpContainment). A genuinely
// human-selected Full Access run is the explicit opposite choice: the user has
// asked for Kimi's own native tools with no TaskWraith approval cards.
//
// This module is the single derivation of that policy. It is a pure function
// of the POST-CLAMP, signature-verified effective permissions that Electron
// main resolved for the run; main owns the decision of what to pass here. It
// never inspects model output, workspace files, tool arguments, provider
// prose, or a global shell setting, and it cannot widen a restricted seat:
// anything that is not an authenticated, write-capable Full Access posture
// stays `contained`.

import { isFullShellAccessGranted } from '../EffectiveRunPermissions'
import type { EffectiveRunPermissions } from '../store/types'

/**
 * `contained` is the production default: deny wall in the isolated profile,
 * native fs/exec/egress refused before any callback, gateway-only workspace
 * access. `native-full-access` omits the deny wall, pins Kimi's documented
 * "Never Ask" permission mode, and auto-allows every native ACP permission
 * request so no TaskWraith card is ever produced for that run.
 */
export type KimiNativeToolPolicy = 'contained' | 'native-full-access'

/**
 * Documented Kimi Code `default_permission_mode` value for "Never Ask"
 * (kimi-code 2.1.1 `--help`: "never interrupts you; everything runs and is
 * decided automatically"). Static `deny` rules still apply under it, which is
 * why the contained profile keeps its wall and this mode is only ever pinned
 * for `native-full-access`.
 */
export const KIMI_NATIVE_FULL_ACCESS_PERMISSION_MODE = 'auto' as const

export interface ResolveKimiNativeToolPolicyInput {
  /**
   * Main-resolved, signature-verified, post-clamp run posture. A missing or
   * unverified posture is `contained`; this helper never verifies signatures
   * itself and must not be handed an unverified payload.
   */
  effectivePermissions: EffectiveRunPermissions | null | undefined
  /** The seat's approval mode. A plan seat is never write-capable. */
  approvalMode?: string | null
}

/**
 * Reuses the shared `isFullShellAccessGranted` predicate (presetId
 * `full_access` with shell `allow`) plus the clamped `readOnly === false`
 * flag instead of introducing a competing Full Access predicate.
 */
export function resolveKimiNativeToolPolicy(
  input: ResolveKimiNativeToolPolicyInput
): KimiNativeToolPolicy {
  const permissions = input.effectivePermissions
  if (!permissions) return 'contained'
  if (input.approvalMode === 'plan') return 'contained'
  if (permissions.readOnly !== false) return 'contained'
  if (!isFullShellAccessGranted(permissions)) return 'contained'
  return 'native-full-access'
}

export function kimiNativeToolsAllowed(policy: KimiNativeToolPolicy | null | undefined): boolean {
  return policy === 'native-full-access'
}
