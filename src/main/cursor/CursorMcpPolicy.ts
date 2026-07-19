import type { UserMcpLaunchServer } from '../UserMcpServers'
import type { EffectiveRunPermissions } from '../store/types'

// Historical/qualification-only policy helpers. Production starts no managed
// Cursor process; these functions do not establish an admissible runtime mode.

type CursorEffectivePermissions = Pick<EffectiveRunPermissions, 'agenticServices'>

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

/** Historical write-path invariant; production Cursor is unconditionally disabled. */
export function assertCursorWriteMcpPosture(
  writeCapable: boolean,
  effectivePermissions: CursorEffectivePermissions | null | undefined
): void {
  if (writeCapable && cursorMcpToolsDenied(effectivePermissions)) {
    throw new Error(
      'The signed run posture denies MCP tools, but Cursor write mode requires the contained TaskWraith MCP broker.'
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
