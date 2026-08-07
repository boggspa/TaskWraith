/**
 * Arg/context-scoped auto-allow for the agent `appshots` capture tool.
 *
 * Kept OUT of MCP_AUTO_ALLOWED_TOOLS on purpose: Plan/Ask must still hit the
 * ordinary mcpTools gate (deny / ask). Mirror EnsembleRosterImportConsent —
 * ownership + posture decide, never a bare tool-name allowlist.
 */

export const APPSHOTS_CAPTURE_TOOL = 'appshots' as const
export const APPSHOTS_STATUS_TOOL = 'appshots_status' as const

const BLOCKED_AUTO_ALLOW_PRESETS = new Set(['plan', 'read_only'])

export interface AppshotsCaptureAutoAllowInput {
  toolName: unknown
  presetId?: string | null
  ownership: { allowed: boolean; reason: string }
}

/**
 * Auto-allow ONLY when:
 * - tool is exactly `appshots`
 * - ownership resolver already allowed the target
 * - posture is not Plan or Ask (`read_only`)
 *
 * Full Access foreign targets still return false here; `mcpTools: 'allow'` on
 * the ordinary gate covers that case after ownership fails this predicate.
 */
export function shouldAutoAllowAppshotsCapture(input: AppshotsCaptureAutoAllowInput): boolean {
  if (input.toolName !== APPSHOTS_CAPTURE_TOOL) return false
  if (!input.ownership?.allowed) return false
  const preset = typeof input.presetId === 'string' ? input.presetId.trim() : ''
  if (preset && BLOCKED_AUTO_ALLOW_PRESETS.has(preset)) return false
  return true
}
