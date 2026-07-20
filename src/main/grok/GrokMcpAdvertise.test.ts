import { describe, expect, it } from 'vitest'
import {
  grokTaskWraithSafeToolRequested,
  shouldAdvertiseTaskWraithMcpToGrok
} from './GrokMcpAdvertise'

describe('grokTaskWraithSafeToolRequested', () => {
  it('allows the TaskWraith-qualified ask_user_question request emitted by Grok ACP', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          rawInput: { tool_name: 'TaskWraith__ask_user_question' }
        }
      })
    ).toBe(true)
  })

  it('still unqualifies the legacy taskwraith-broker alias for safe tools', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          rawInput: { tool_name: 'taskwraith-broker__ask_user_question' }
        }
      })
    ).toBe(true)
  })

  it('retains the configured read-only scoped namespace', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'taskwraith-grok__read_file'
      })
    ).toBe(true)
  })

  it('fails closed for mutating tools and unrecognized namespaces', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'TaskWraith__write_file'
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'taskwraith-broker__write_file'
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'other-broker__ask_user_question'
      })
    ).toBe(false)
  })
})

describe('shouldAdvertiseTaskWraithMcpToGrok', () => {
  it('never advertises outside ACP', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: false,
        approvalMode: 'default',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(false)
  })

  it('auto-advertises write-capable ACP turns', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'default',
        bridgeEnabled: false,
        readOnlyAdvertiseEnabled: false
      })
    ).toBe(true)
  })

  it('requires both read-only gates for plan-mode ACP turns', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: false,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(true)
  })
})
