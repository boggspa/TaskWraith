import { grokWriteCapable } from './GrokCliArgs'

/**
 * Exact eligibility for attaching TaskWraith MCP to a Grok ACP session/new.
 * Write-capable ACP turns auto-attach it; read-only turns require both the
 * global bridge preference and the explicit read-only advertise gate.
 */
export function shouldAdvertiseTaskWraithMcpToGrok(input: {
  acpEnabled: boolean
  approvalMode?: string | null
  bridgeEnabled: boolean
  readOnlyAdvertiseEnabled: boolean
}): boolean {
  if (!input.acpEnabled) return false
  return (
    grokWriteCapable(input.approvalMode) ||
    (input.bridgeEnabled && input.readOnlyAdvertiseEnabled)
  )
}
