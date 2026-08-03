import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON,
  isAntigravityHeadlessPermissionNoOutput
} from './AntigravityRunDiagnostics'

describe('AntiGravity native run diagnostics', () => {
  it('recognises the official agy headless read permission/no-output failure', () => {
    expect(
      isAntigravityHeadlessPermissionNoOutput(
        'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.'
      )
    ).toBe(true)
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).toContain('read_file')
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).not.toContain(
      '--dangerously-skip-permissions'
    )
  })

  it('does not classify unrelated provider errors as this condition', () => {
    expect(isAntigravityHeadlessPermissionNoOutput('prompt is too long')).toBe(false)
    expect(isAntigravityHeadlessPermissionNoOutput('no output produced')).toBe(false)
    expect(isAntigravityHeadlessPermissionNoOutput('permission denied for write_file')).toBe(false)
  })
})
