import type { AppSettings } from '../../../main/store/types'
import {
  DEFAULT_APPROVAL_KIND_TIMEOUTS_MS,
  DEFAULT_APPROVAL_TIMEOUTS_MS
} from '../../../shared/interactionTimeouts'
import type { AgentApprovalRequest } from './agentApprovalTypes'

const PER_KIND_OVERRIDES_MS: Readonly<Record<string, number>> = DEFAULT_APPROVAL_KIND_TIMEOUTS_MS

const FALLBACK_PROVIDER_MS = DEFAULT_APPROVAL_TIMEOUTS_MS.claude

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
