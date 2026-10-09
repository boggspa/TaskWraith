import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from '../store/types'
import {
  KIMI_NATIVE_FULL_ACCESS_PERMISSION_MODE,
  kimiNativeToolsAllowed,
  resolveKimiNativeToolPolicy
} from './KimiNativeFullAccess'

const fullAccess = (over: Partial<EffectiveRunPermissions> = {}): EffectiveRunPermissions =>
  ({
    presetId: 'full_access',
    readOnly: false,
    agenticServices: { shellCommands: 'allow', fileChanges: 'allow' },
    ...over
  }) as unknown as EffectiveRunPermissions

describe('resolveKimiNativeToolPolicy', () => {
  it('allows native tools only for a verified, write-capable full_access posture', () => {
    expect(resolveKimiNativeToolPolicy({ effectivePermissions: fullAccess() })).toBe(
      'native-full-access'
    )
    expect(
      resolveKimiNativeToolPolicy({ effectivePermissions: fullAccess(), approvalMode: 'auto' })
    ).toBe('native-full-access')
  })

  it('stays contained without a posture', () => {
    expect(resolveKimiNativeToolPolicy({ effectivePermissions: null })).toBe('contained')
    expect(resolveKimiNativeToolPolicy({ effectivePermissions: undefined })).toBe('contained')
  })

  it('stays contained for every lesser preset even with shell allow', () => {
    for (const presetId of ['default', 'accept_edits', 'full_workspace', 'plan']) {
      expect(
        resolveKimiNativeToolPolicy({
          effectivePermissions: fullAccess({ presetId } as Partial<EffectiveRunPermissions>)
        })
      ).toBe('contained')
    }
  })

  it('stays contained when the clamped posture is read-only or shell is not allow', () => {
    expect(
      resolveKimiNativeToolPolicy({ effectivePermissions: fullAccess({ readOnly: true }) })
    ).toBe('contained')
    expect(
      resolveKimiNativeToolPolicy({
        effectivePermissions: fullAccess({ readOnly: undefined as unknown as boolean })
      })
    ).toBe('contained')
    expect(
      resolveKimiNativeToolPolicy({
        effectivePermissions: fullAccess({
          agenticServices: { shellCommands: 'ask', fileChanges: 'allow' }
        } as Partial<EffectiveRunPermissions>)
      })
    ).toBe('contained')
  })

  it('never lets a plan seat use native tools', () => {
    expect(
      resolveKimiNativeToolPolicy({ effectivePermissions: fullAccess(), approvalMode: 'plan' })
    ).toBe('contained')
  })

  it('pins the documented Never Ask mode token and exposes the boolean port', () => {
    expect(KIMI_NATIVE_FULL_ACCESS_PERMISSION_MODE).toBe('auto')
    expect(kimiNativeToolsAllowed('native-full-access')).toBe(true)
    expect(kimiNativeToolsAllowed('contained')).toBe(false)
    expect(kimiNativeToolsAllowed(null)).toBe(false)
    expect(kimiNativeToolsAllowed(undefined)).toBe(false)
  })
})
