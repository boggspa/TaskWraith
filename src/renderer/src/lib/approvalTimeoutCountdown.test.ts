import { describe, expect, it } from 'vitest'
import { formatApprovalCountdown, resolveApprovalTimeoutMs } from './approvalTimeoutCountdown'
import type { AgentApprovalRequest } from './agentApprovalTypes'

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
  perProviderMs: {
    gemini: 120_000,
    codex: 30_000,
    claude: 120_000,
    kimi: 60_000,
    grok: 120_000,
    cursor: 120_000,
    ollama: 120_000
  },
  mainAuthorityMs: 60_000
}

describe('resolveApprovalTimeoutMs', () => {
  it('returns null when timeouts are disabled', () => {
    expect(
      resolveApprovalTimeoutMs(baseApproval, { ...settings, enabled: false })
    ).toBeNull()
  })

  it('uses per-provider defaults', () => {
    expect(resolveApprovalTimeoutMs(baseApproval, settings)).toBe(30_000)
  })

  it('prefers per-kind overrides', () => {
    expect(
      resolveApprovalTimeoutMs(
        { ...baseApproval, method: 'hostCommand/rerun' },
        settings
      )
    ).toBe(90_000)
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
