import { describe, expect, it } from 'vitest'
import { isDeadTokenReason } from './apnsSendCore'

describe('isDeadTokenReason', () => {
  it('reaps only Apple-authoritative unregistration responses', () => {
    expect(isDeadTokenReason('Unregistered')).toBe(true)
    expect(isDeadTokenReason('unregistered')).toBe(true)
    expect(isDeadTokenReason('BadDeviceToken')).toBe(false)
    expect(isDeadTokenReason(undefined)).toBe(false)
  })
})
