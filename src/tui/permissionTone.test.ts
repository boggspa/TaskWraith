import { describe, expect, it } from 'vitest'
import { resolveTuiTheme } from './palette'
import { permissionTone, permissionToneHex } from './permissionTone'

describe('TUI permission tones', () => {
  it('maps the five exact postures onto four semantic tiers', () => {
    expect(permissionTone('plan')).toBe('info')
    expect(permissionTone('read_only')).toBe('info')
    expect(permissionTone('default')).toBe('primary')
    expect(permissionTone('workspace_write')).toBe('warning')
    expect(permissionTone('full_access')).toBe('error')
  })

  it('uses the frozen dark and light permission colors independently of status tones', () => {
    const dark = resolveTuiTheme('wraith-night').tone.permission
    const light = resolveTuiTheme('wraith-day').tone.permission
    expect(['plan', 'read_only'].map((id) => permissionToneHex(id, dark))).toEqual([
      '#6FB6FF',
      '#6FB6FF'
    ])
    expect(permissionToneHex('default', dark)).toBe('#FFFFFF')
    expect(permissionToneHex('workspace_write', dark)).toBe('#F59E0B')
    expect(permissionToneHex('full_access', dark)).toBe('#DC2626')
    expect(permissionToneHex('plan', light)).toBe('#1976D2')
    expect(permissionToneHex('default', light)).toBe('#1D1D1F')
    expect(permissionToneHex('workspace_write', light)).toBe('#D97706')
    expect(permissionToneHex('full_access', light)).toBe('#991B1B')
  })
})
