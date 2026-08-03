import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON,
  isAntigravityHeadlessPermissionNoOutput
} from './AntigravityRunDiagnostics'

describe('AntiGravity native run diagnostics', () => {
  it.each(['read_file', 'write_file', 'command'])(
    'recognises the official agy headless %s permission/no-output failure',
    (permission) => {
      expect(
        isAntigravityHeadlessPermissionNoOutput(
          `jetski: no output produced — a tool required the "${permission}" permission that headless mode cannot prompt for, so it was auto-denied.`
        )
      ).toBe(true)
    }
  )

  it('keeps the diagnostic actionable without recommending the bypass flag', () => {
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).toContain('read_file')
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).toContain('command')
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).not.toContain(
      '--dangerously-skip-permissions'
    )
  })

  it('does not classify unrelated provider errors as this condition', () => {
    expect(isAntigravityHeadlessPermissionNoOutput('prompt is too long')).toBe(false)
    expect(isAntigravityHeadlessPermissionNoOutput('no output produced')).toBe(false)
    expect(isAntigravityHeadlessPermissionNoOutput('permission denied for command')).toBe(false)
  })
})
