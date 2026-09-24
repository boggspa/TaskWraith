import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string): string =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')

/*
 * The approval countdown used to subscribe to the shared 1 Hz tick inside
 * ComposerInner, reconciling the whole composer (and the Allow/Deny buttons)
 * every second. The tick lives in ApprovalTimeoutCountdown now.
 */
describe('approval overlay countdown isolation', () => {
  it('keeps the approval countdown tick out of ComposerInner', () => {
    const composer = readSource('src/renderer/src/components/Composer.tsx')
    const countdown = readSource('src/renderer/src/components/ApprovalTimeoutCountdown.tsx')

    expect(composer).not.toMatch(/agentApprovalNowTick\s*=\s*useSharedNowTick/)
    expect(composer).not.toContain('formatApprovalCountdown(')
    expect(composer).toContain('<ApprovalTimeoutCountdown')
    expect(countdown).toContain('useSharedNowTick(true)')
    expect(countdown).toContain('formatApprovalCountdown(')
    expect(countdown).toContain('id="composer-agent-approval-countdown"')
  })
})
