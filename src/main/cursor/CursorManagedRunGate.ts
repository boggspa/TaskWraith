export interface CursorManagedRunAdmission {
  allowed: false
  securityUnavailable: true
  message: string
}

/**
 * Exact-build release gate for Cursor. This is deliberately unconditional:
 * authentication and a private filesystem profile do not contain Cursor's
 * provider-managed startup hooks, skills, plugins, MCP sources, or retained
 * approvals. Production callers must return this result before resolving or
 * spawning cursor-agent.
 */
export function cursorManagedRunAdmission(): CursorManagedRunAdmission {
  return {
    allowed: false,
    securityUnavailable: true,
    message:
      'Cursor managed runs are temporarily disabled: the current Cursor CLI initializes provider-managed account/team hooks, skills, plugins, and MCP sources before a turn, and TaskWraith has not yet qualified containment for those startup surfaces. No Cursor process was started. Use another provider while the exact-build containment canary is pending.'
  }
}
