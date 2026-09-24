import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON,
  ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON,
  antigravityHeadlessPermissionReason,
  clearAntigravityLeaseSkip,
  isAntigravityHeadlessPermissionNoOutput,
  isAntigravityPrintModeTimeout,
  noteAntigravityLeaseSkipped
} from './AntigravityRunDiagnostics'
import { AGY_PRINT_TIMEOUT } from '../../shared/antigravityPrintTimeout'

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

describe('AntiGravity print-mode wall-clock timeout', () => {
  it('recognises the exact stderr agy emits when --print-timeout expires', () => {
    expect(isAntigravityPrintModeTimeout('Error: timeout waiting for response\n')).toBe(true)
    // Real stderr arrives with earlier lines and platform newlines attached.
    expect(
      isAntigravityPrintModeTimeout(
        'agy: starting print turn\r\nError: timeout waiting for response\r\n'
      )
    ).toBe(true)
  })

  it('does not claim unrelated timeouts for the print-mode wall clock', () => {
    // A same-worded timeout from another limb: the trailing clause is the only
    // thing separating an MCP stall from the print cap, so the matcher anchors
    // to the end of the line.
    expect(
      isAntigravityPrintModeTimeout('Error: timeout waiting for response from the MCP broker')
    ).toBe(false)
    expect(isAntigravityPrintModeTimeout('MCP Error: timeout waiting for response')).toBe(false)
    expect(isAntigravityPrintModeTimeout('Error: timed out waiting for response')).toBe(false)
    expect(isAntigravityPrintModeTimeout('Error: request timeout')).toBe(false)
    expect(isAntigravityPrintModeTimeout(undefined)).toBe(false)
  })

  it('blames the wall clock by name and quotes the value actually configured', () => {
    expect(ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON).toContain('--print-timeout')
    expect(ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON).toContain(AGY_PRINT_TIMEOUT)
    // The bare agy line reads like a network fault; the reason must not, and it
    // must not send the operator to agy's allow rules for a clock expiry.
    expect(ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON).toContain('wall clock')
    expect(ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON).not.toContain('allow rule')
    expect(ANTIGRAVITY_PRINT_MODE_TIMEOUT_REASON).not.toContain('auto-denied')
  })
})
