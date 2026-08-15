import { describe, expect, it } from 'vitest'
import { formatApprovalCountdown, resolveApprovalTimeoutMs } from './approvalTimeoutCountdown'
import type { AgentApprovalRequest } from './agentApprovalTypes'
import {
  DEFAULT_APPROVAL_TIMEOUTS_MS,
  DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
} from '../../../shared/interactionTimeouts'

const baseApproval: AgentApprovalRequest = {
  id: 'a-1',
  provider: 'codex',
  method: 'run_shell_command',
  title: 'Run command',
  body: 'ls',
  actions: ['accept', 'decline']
}

const settings = {
  enabled: true,
  perProviderMs: { ...DEFAULT_APPROVAL_TIMEOUTS_MS },
  mainAuthorityMs: DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
}

describe('resolveApprovalTimeoutMs', () => {
  it('returns null when timeouts are disabled', () => {
    expect(
      resolveApprovalTimeoutMs(baseApproval, { ...settings, enabled: false })
    ).toBeNull()
  })

  it('uses per-provider defaults', () => {
    expect(resolveApprovalTimeoutMs(baseApproval, settings)).toBe(60_000)
  })

  it('prefers per-kind overrides', () => {
    expect(
      resolveApprovalTimeoutMs(
        { ...baseApproval, method: 'hostCommand/rerun' },
        settings
      )
    ).toBe(180_000)
  })

  it('keeps the Kimi roster override below its external client deadline', () => {
    expect(
      resolveApprovalTimeoutMs(
        { ...baseApproval, provider: 'kimi', method: 'kimi-mcp/ensemble_roster_edit' },
        settings
      )
    ).toBe(40_000)
  })
})

describe('formatApprovalCountdown', () => {
  it('formats sub-minute values', () => {
    expect(formatApprovalCountdown(12_500)).toBe('13s')
  })

  it('formats minute values', () => {
    expect(formatApprovalCountdown(125_000)).toBe('2m 5s')
  })
})
