import type { UserMcpLaunchServer } from '../UserMcpServers'
import type { EffectiveRunPermissions } from '../store/types'

// Cursor Path-B policy helpers. The signed run posture decides whether the
// TaskWraith broker may attach; it does not decide whether Cursor itself is
// selectable. A posture-denied or failed broker attachment leaves the managed
// Cursor launch on its native-tool stack under the pinned OS sandbox.

type CursorEffectivePermissions = Pick<EffectiveRunPermissions, 'agenticServices' | 'presetId'>

/**
 * Read Cursor's MCP ceiling from the canonical, main-resolved run posture.
 * There is deliberately no Cursor-local policy fallback: an explicit deny in
 * the signed posture is the authority used by both config and argv assembly.
 */
export function cursorMcpToolsDenied(
  effectivePermissions: CursorEffectivePermissions | null | undefined
): boolean {
  return effectivePermissions?.agenticServices?.mcpTools === 'deny'
}

/**
 * Whether the managed TaskWraith broker may attach for this Cursor seat.
 *
 * Plan keeps `mcpTools: 'deny'` (no mid-run modals for generic MCP) but still
 * needs the scoped safe/plan-subset broker so gated instruments such as
 * `delegate_to_subthread` can be listed and modal-approved. User-owned MCP
 * servers remain gated by {@link cursorMcpToolsDenied} alone.
 */
export function cursorTaskWraithBrokerAttachAllowed(
  effectivePermissions: CursorEffectivePermissions | null | undefined
): boolean {
  if (!effectivePermissions) return false
  if (!cursorMcpToolsDenied(effectivePermissions)) return true
  return effectivePermissions.presetId === 'plan'
}

/**
 * Legacy broker-dependent qualification invariant. Production Path-B does not
 * call this helper: its write seat may continue native-only under the sandbox
 * when the governed broker is posture-denied or cannot attach.
 */
export function assertCursorWriteMcpPosture(
  writeCapable: boolean,
  effectivePermissions: CursorEffectivePermissions | null | undefined
): void {
  if (writeCapable && cursorMcpToolsDenied(effectivePermissions)) {
    throw new Error(
      'The signed run posture denies MCP tools, so this broker-dependent Cursor qualification posture cannot run.'
    )
  }
}

/**
 * Resolve user MCP servers only when the canonical run posture permits MCP.
 * Keeping the resolver lazy also prevents secret resolution and plugin launch
 * validation from running for a seat whose MCP surface is denied.
 */
export function resolveCursorUserMcpLaunchServers(
  effectivePermissions: CursorEffectivePermissions | null | undefined,
  resolve: () => UserMcpLaunchServer[]
): UserMcpLaunchServer[] {
  return cursorMcpToolsDenied(effectivePermissions) ? [] : resolve()
}
