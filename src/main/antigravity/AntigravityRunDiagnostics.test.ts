import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON,
  antigravityHeadlessPermissionReason,
  clearAntigravityLeaseSkip,
  isAntigravityHeadlessPermissionNoOutput,
  noteAntigravityLeaseSkipped
} from './AntigravityRunDiagnostics'

describe('agy lease-skip attribution', () => {
  it('keeps the agy allow-rule advice when a lease WAS installed', () => {
    // agy refusing despite a lease is the one case where "configure the
    // matching agy allow rule" is genuinely the right advice.
    expect(antigravityHeadlessPermissionReason('run-no-cause')).toBe(
      ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
    )
    expect(antigravityHeadlessPermissionReason()).toBe(
      ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
    )
  })

  it('names the TaskWraith-side cause when the lease was skipped', () => {
    noteAntigravityLeaseSkipped('run-skipped', 'run admission denied')
    const reason = antigravityHeadlessPermissionReason('run-skipped')
    expect(reason).toContain('installed NO permission lease')
    expect(reason).toContain('run admission denied')
    // The operator must not be sent to agy's settings for a cause on our side.
    expect(reason).toContain('not an agy allow-rule gap')
    clearAntigravityLeaseSkip('run-skipped')
    expect(antigravityHeadlessPermissionReason('run-skipped')).toBe(
      ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
    )
  })

  it('ignores empty run ids and empty causes rather than recording noise', () => {
    noteAntigravityLeaseSkipped('', 'run admission denied')
    noteAntigravityLeaseSkipped('run-blank-cause', '   ')
    expect(antigravityHeadlessPermissionReason('run-blank-cause')).toBe(
      ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
    )
  })
})

describe('AntiGravity native run diagnostics', () => {
  it.each(['read_file', 'write_file', 'command', 'unsandboxed'])(
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
    expect(ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON).toContain('unsandboxed')
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
