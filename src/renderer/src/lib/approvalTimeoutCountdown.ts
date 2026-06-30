import type { AppSettings } from '../../../main/store/types'
import type { AgentApprovalRequest } from './agentApprovalTypes'

const PER_KIND_OVERRIDES_MS: Record<string, number> = {
  'hostCommand/rerun': 90_000,
  'workspace/session-trust': 180_000
}

const FALLBACK_PROVIDER_MS = 120_000

export function resolveApprovalTimeoutMs(
  approval: AgentApprovalRequest,
  settings: AppSettings['approvalTimeouts']
): number | null {
  if (!settings.enabled) return null
  if (approval.method && PER_KIND_OVERRIDES_MS[approval.method]) {
    return PER_KIND_OVERRIDES_MS[approval.method]
  }
  const providerMs =
    settings.perProviderMs[approval.provider as keyof typeof settings.perProviderMs]
  return providerMs ?? FALLBACK_PROVIDER_MS
}

export function formatApprovalCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  }
  return `${seconds}s`
}