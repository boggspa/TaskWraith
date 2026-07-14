import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import {
  armScheduledLoopStepTimeout,
  scheduledHeadlessComposeFields
} from './ScheduledHeadlessRun'

describe('scheduledHeadlessComposeFields', () => {
  it('preserves the durable occurrence posture and provider controls', () => {
    const geminiWorktree = {
      enabled: true,
      name: 'scheduled-test-2',
      effectivePath: '/Users/chrisizatt/Documents/Test 2-worktree'
    } as const

    expect(
      scheduledHeadlessComposeFields({
        workflowMode: 'plan',
        permissionPresetId: 'read_only',
        geminiWorktree,
        kimiFastMode: true
      })
    ).toEqual({
      workflowMode: 'plan',
      permissionPresetId: 'read_only',
      geminiWorktree,
      kimiFastMode: true
    })
  })
})

describe('armScheduledLoopStepTimeout', () => {
  it('cancels a cross-provider verifier through its compose provider', async () => {
    vi.useFakeTimers()
    const cancelProviderRun = vi.fn(() => Promise.resolve())
    const handleExit = vi.fn()

    const clear = armScheduledLoopStepTimeout({
      composeProvider: 'claude',
      runId: 'loop-grok-verifier-1',
      timeoutMs: 500,
      cancelProviderRun,
      handleExit
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(cancelProviderRun).toHaveBeenCalledWith('claude', 'loop-grok-verifier-1')
    expect(cancelProviderRun).not.toHaveBeenCalledWith('grok', expect.any(String))
    expect(handleExit).toHaveBeenCalledWith('loop-grok-verifier-1', -1)

    clear()
    vi.useRealTimers()
  })

  it('can be cleared after a completed step', async () => {
    vi.useFakeTimers()
    const cancelProviderRun = vi.fn()
    const handleExit = vi.fn()
    const clear = armScheduledLoopStepTimeout({
      composeProvider: 'grok',
      runId: 'loop-grok-maker-1',
      timeoutMs: 500,
      cancelProviderRun,
      handleExit
    })

    clear()
    await vi.advanceTimersByTimeAsync(500)
    expect(cancelProviderRun).not.toHaveBeenCalled()
    expect(handleExit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('scheduled headless dispatch integration', () => {
  const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  it('uses the durable compose fields for both loop and solo headless runs', () => {
    expect(indexSource.match(/\.\.\.scheduledHeadlessComposeFields\(task\)/g)).toHaveLength(2)
  })

  it('arms loop timeouts with the provider that composed the current step', () => {
    expect(indexSource).toContain('armScheduledLoopStepTimeout({\n      composeProvider,')
    expect(indexSource).not.toContain('cancelProviderRun(task.provider, input.runId)')
  })

  it('verifies scheduled attachment ownership without minting it during dispatch', () => {
    expect(indexSource).toContain('function verifyScheduledTaskAttachmentOwnership(')
    expect(indexSource).toContain('scheduledAttachmentPersistence.resolve({')
    expect(indexSource).not.toContain('function grantScheduledTaskAttachmentOwnership(')
    expect(indexSource).not.toContain(
      'scheduled attachment ownership failed for ${task.id}: ${granted.reason}'
    )
  })
})
