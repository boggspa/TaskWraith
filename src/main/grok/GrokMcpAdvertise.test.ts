import { describe, expect, it } from 'vitest'
import { shouldAdvertiseTaskWraithMcpToGrok } from './GrokMcpAdvertise'

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
