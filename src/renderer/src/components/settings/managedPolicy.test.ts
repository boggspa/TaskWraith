import { describe, expect, it } from 'vitest'
import {
  isManagedPolicySettingLocked,
  managedPolicySettingList,
  type ManagedPolicyStatus
} from './managedPolicy'

describe('managedPolicySettingList', () => {
  it('returns an empty list for anything that is not an array', () => {
    // An MDM payload can omit the key entirely or ship the wrong shape; the
    // caller must still get a list it can `.includes()` against.
    expect(managedPolicySettingList(undefined)).toEqual([])
    expect(managedPolicySettingList(null)).toEqual([])
    expect(managedPolicySettingList('userMcpServers')).toEqual([])
    expect(managedPolicySettingList({ 0: 'userMcpServers' })).toEqual([])
  })

  it('keeps array entries in order', () => {
    expect(managedPolicySettingList(['userMcpServers', 'agenticServices'])).toEqual([
      'userMcpServers',
      'agenticServices'
    ])
  })

  it('trims surrounding whitespace off each entry', () => {
    expect(managedPolicySettingList(['  userMcpServers  ', '\tagenticServices\n'])).toEqual([
      'userMcpServers',
      'agenticServices'
    ])
  })

  it('drops entries that are blank once trimmed', () => {
    expect(managedPolicySettingList(['userMcpServers', '', '   ', 'agenticServices'])).toEqual([
      'userMcpServers',
      'agenticServices'
    ])
  })

  it('drops nullish and falsy entries rather than stringifying them', () => {
    // `String(entry || '')` deliberately maps every falsy entry to '', so a
    // stray null never becomes the literal setting name "null".
    expect(managedPolicySettingList([null, undefined, false, 0, 'userMcpServers'])).toEqual([
      'userMcpServers'
    ])
  })

  it('coerces truthy non-string entries to strings', () => {
    expect(managedPolicySettingList([42, true])).toEqual(['42', 'true'])
  })
})

describe('isManagedPolicySettingLocked', () => {
  const locked = (overrides: ManagedPolicyStatus = {}): ManagedPolicyStatus => ({
    active: true,
    lockedSettings: ['userMcpServers'],
    enforcedSettings: ['auditRetention'],
    ...overrides
  })

  it('is false when there is no status at all', () => {
    expect(isManagedPolicySettingLocked(null, 'userMcpServers')).toBe(false)
    expect(isManagedPolicySettingLocked(undefined, 'userMcpServers')).toBe(false)
  })

  it('is false when the policy is not active, even if the setting is listed', () => {
    // The whole point of the `active` gate: an inactive profile must not lock
    // controls, however fully populated its lists are.
    expect(isManagedPolicySettingLocked(locked({ active: false }), 'userMcpServers')).toBe(false)
    expect(isManagedPolicySettingLocked(locked({ active: undefined }), 'userMcpServers')).toBe(
      false
    )
    expect(
      isManagedPolicySettingLocked({ lockedSettings: ['userMcpServers'] }, 'userMcpServers')
    ).toBe(false)
  })

  it('requires active to be the boolean true, not merely truthy', () => {
    // `status?.active !== true` is strict on purpose: a JSON payload carrying
    // the string "true" must not silently lock the UI.
    expect(isManagedPolicySettingLocked(locked({ active: 'true' }), 'userMcpServers')).toBe(false)
    expect(isManagedPolicySettingLocked(locked({ active: 1 }), 'userMcpServers')).toBe(false)
  })

  it('is true for a setting named in lockedSettings', () => {
    expect(isManagedPolicySettingLocked(locked(), 'userMcpServers')).toBe(true)
  })

  it('is true for a setting named in enforcedSettings', () => {
    expect(isManagedPolicySettingLocked(locked(), 'auditRetention')).toBe(true)
  })

  it('is false for an active policy that does not name the setting', () => {
    expect(isManagedPolicySettingLocked(locked(), 'geminiMcpBridge')).toBe(false)
  })

  it('matches a listed entry that carries surrounding whitespace', () => {
    expect(
      isManagedPolicySettingLocked(
        locked({ lockedSettings: ['  userMcpServers  '] }),
        'userMcpServers'
      )
    ).toBe(true)
  })

  it('is exact rather than substring-based', () => {
    expect(
      isManagedPolicySettingLocked(locked({ lockedSettings: ['userMcp'] }), 'userMcpServers')
    ).toBe(false)
  })

  it('tolerates malformed list fields without throwing', () => {
    const malformed = locked({ lockedSettings: 'userMcpServers', enforcedSettings: null })
    expect(() => isManagedPolicySettingLocked(malformed, 'userMcpServers')).not.toThrow()
    expect(isManagedPolicySettingLocked(malformed, 'userMcpServers')).toBe(false)
  })

  it('falls back to enforcedSettings when lockedSettings is malformed', () => {
    const partial = locked({ lockedSettings: undefined, enforcedSettings: ['auditRetention'] })
    expect(isManagedPolicySettingLocked(partial, 'auditRetention')).toBe(true)
  })
})
