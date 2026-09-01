import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalTimeoutScheduler,
  DEFAULT_APPROVAL_TIMEOUT_POLICY,
  type ApprovalTimeoutPolicy,
  type ApprovalTimeoutReason
} from './ApprovalTimeoutScheduler'

interface ScheduledCallback {
  cb: () => void
  ms: number
  id: number
}

/**
 * Tiny fake-clock helper. Exposes `advance(ms)` to fire any scheduled
 * callback whose delay has elapsed. Lets us drive `ApprovalTimeoutScheduler`
 * deterministically without `vi.useFakeTimers()` global state.
 */
interface FakeClock {
  setTimeoutFn: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimeoutFn: (handle: NodeJS.Timeout) => void
  advance: (ms: number) => Promise<void>
  readonly pending: number
}

function makeFakeClock(): FakeClock {
  let now = 0
  let nextId = 1
  const queue: ScheduledCallback[] = []

  const setTimeoutFn = (cb: () => void, ms: number): NodeJS.Timeout => {
    const id = nextId++
    queue.push({ cb, ms: now + ms, id })
    return id as unknown as NodeJS.Timeout
  }
  const clearTimeoutFn = (handle: NodeJS.Timeout): void => {
    const id = handle as unknown as number
    const idx = queue.findIndex((q) => q.id === id)
    if (idx >= 0) queue.splice(idx, 1)
  }
  const advance = async (ms: number): Promise<void> => {
    now += ms
    // Fire callbacks whose due-time has now passed, in insertion order.
    while (true) {
      const next = queue.find((q) => q.ms <= now)
      if (!next) break
      const idx = queue.indexOf(next)
      queue.splice(idx, 1)
      await next.cb()
    }
  }
  return {
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    get pending() {
      return queue.length
    }
  }
}

describe('ApprovalTimeoutScheduler', () => {
  it('schedules a timer using the provider default', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    const result = scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    expect(result.appliedMs).toBe(60_000)
    expect(result.source).toBe('providerDefault')
    expect(scheduler.pendingCount).toBe(1)
  })

  it('fires onTimeout after the elapsed delay', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    await clock.advance(59_999)
    expect(onTimeout).not.toHaveBeenCalled()
    await clock.advance(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0][0]).toMatchObject({
      approvalId: 'a1',
      appliedMs: 60_000,
      source: 'providerDefault'
    })
    expect(scheduler.pendingCount).toBe(0)
  })

  it('cancel() prevents the callback from firing', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    const cancelled = scheduler.cancel('a1')
    expect(cancelled).toBe(true)
    await clock.advance(60_000)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(scheduler.pendingCount).toBe(0)
  })

  it('cancel() on an unknown id is a silent no-op', () => {
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, vi.fn())
    expect(scheduler.cancel('does-not-exist')).toBe(false)
  })

  it('re-scheduling the same id replaces the previous timer', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    scheduler.schedule({ approvalId: 'a1', provider: 'gemini' }) // 240s
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' }) // 60s
    expect(scheduler.pendingCount).toBe(1)
    await clock.advance(60_000)
    // Codex timer fired — gemini timer should have been replaced.
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0][0].appliedMs).toBe(60_000)
  })

  it('main authority approvals use mainTimeoutMs over the provider default', () => {
    const policy: ApprovalTimeoutPolicy = {
      ...DEFAULT_APPROVAL_TIMEOUT_POLICY,
      mainTimeoutMs: 999_000
    }
    const scheduler = new ApprovalTimeoutScheduler(policy, vi.fn())
    const { ms, source } = scheduler.resolveTimeout({
      approvalId: 'a',
      provider: 'codex',
      isMainAuthority: true
    })
    expect(ms).toBe(999_000)
    expect(source).toBe('mainAuthority')
  })

  it('per-kind override beats main-authority and provider default', () => {
    const policy: ApprovalTimeoutPolicy = {
      defaultTimeoutsMs: {
        codex: 30_000,
        claude: 120_000,
        gemini: 120_000,
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000,
        antigravity: 120_000,
        pi: 120_000,
        mistral: 120_000,
        muse: 120_000,
        devin: 120_000
      },
      mainTimeoutMs: 60_000,
      perKindOverridesMs: { 'hostCommand/rerun': 90_000 }
    }
    const scheduler = new ApprovalTimeoutScheduler(policy, vi.fn())
    const { ms, source } = scheduler.resolveTimeout({
      approvalId: 'a',
      provider: 'codex',
      isMainAuthority: true,
      kind: 'hostCommand/rerun'
    })
    expect(ms).toBe(90_000)
    expect(source).toBe('perKind')
  })

  it('cancelAll() clears every scheduled timer', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    scheduler.schedule({ approvalId: 'a', provider: 'codex' })
    scheduler.schedule({ approvalId: 'b', provider: 'gemini' })
    scheduler.schedule({ approvalId: 'c', provider: 'kimi' })
    expect(scheduler.pendingCount).toBe(3)
    scheduler.cancelAll()
    expect(scheduler.pendingCount).toBe(0)
    await clock.advance(10 * 60_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('onTimeout exceptions do not break the scheduler', async () => {
    const clock = makeFakeClock()
    const log = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(
      DEFAULT_APPROVAL_TIMEOUT_POLICY,
      () => {
        throw new Error('boom')
      },
      { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, log }
    )
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    await clock.advance(60_000)
    expect(scheduler.pendingCount).toBe(0)
    const logged = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(logged).toContain('onTimeout threw')
    expect(logged).toContain('a1')
    // Subsequent schedules still work.
    scheduler.schedule({ approvalId: 'a2', provider: 'kimi' })
    expect(scheduler.pendingCount).toBe(1)
  })

  it('has() reflects whether an id is currently scheduled', () => {
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, vi.fn())
    expect(scheduler.has('a')).toBe(false)
    scheduler.schedule({ approvalId: 'a', provider: 'codex' })
    expect(scheduler.has('a')).toBe(true)
    scheduler.cancel('a')
    expect(scheduler.has('a')).toBe(false)
  })

  it('updatePolicy replaces values for future schedules without affecting armed timers', async () => {
    const clock = makeFakeClock()
    const onTimeout = vi.fn()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, onTimeout, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    // Arm a Codex timer with the original 60s policy.
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    // Now bump Codex to 180s — should only affect a2, not a1.
    scheduler.updatePolicy({
      defaultTimeoutsMs: {
        ...DEFAULT_APPROVAL_TIMEOUT_POLICY.defaultTimeoutsMs,
        codex: 180_000
      }
    })
    scheduler.schedule({ approvalId: 'a2', provider: 'codex' })
    await clock.advance(60_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0][0].approvalId).toBe('a1')
    expect(onTimeout.mock.calls[0][0].appliedMs).toBe(60_000)
    await clock.advance(120_000)
    expect(onTimeout).toHaveBeenCalledTimes(2)
    expect(onTimeout.mock.calls[1][0].approvalId).toBe('a2')
    expect(onTimeout.mock.calls[1][0].appliedMs).toBe(180_000)
  })

  it('updatePolicy preserves per-kind overrides when not specified', () => {
    const scheduler = new ApprovalTimeoutScheduler(
      {
        ...DEFAULT_APPROVAL_TIMEOUT_POLICY,
        perKindOverridesMs: { 'hostCommand/rerun': 90_000 }
      },
      vi.fn()
    )
    scheduler.updatePolicy({
      mainTimeoutMs: 999_000
    })
    const { ms } = scheduler.resolveTimeout({
      approvalId: 'a',
      provider: 'codex',
      kind: 'hostCommand/rerun'
    })
    expect(ms).toBe(90_000)
  })

  it('default policy carries the doubled provider and action windows', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_POLICY.defaultTimeoutsMs).toEqual({
      gemini: 240_000,
      codex: 60_000,
      claude: 240_000,
      kimi: 120_000,
      grok: 240_000,
      cursor: 240_000,
      ollama: 240_000,
      antigravity: 240_000,
      pi: 240_000,
      mistral: 120_000,
      muse: 240_000,
      devin: 240_000
    })
    expect(DEFAULT_APPROVAL_TIMEOUT_POLICY.mainTimeoutMs).toBe(120_000)
    expect(DEFAULT_APPROVAL_TIMEOUT_POLICY.perKindOverridesMs?.['hostCommand/rerun']).toBe(180_000)
    expect(DEFAULT_APPROVAL_TIMEOUT_POLICY.perKindOverridesMs?.['workspace/session-trust']).toBe(
      360_000
    )
    expect(
      DEFAULT_APPROVAL_TIMEOUT_POLICY.perKindOverridesMs?.['kimi-mcp/ensemble_roster_edit']
    ).toBe(40_000)
  })

  it('settles Kimi roster approvals before the MCP client deadline', () => {
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, vi.fn())
    expect(
      scheduler.resolveTimeout({
        approvalId: 'kimi-roster',
        provider: 'kimi',
        kind: 'kimi-mcp/ensemble_roster_edit'
      })
    ).toEqual({ ms: 40_000, source: 'perKind' })
  })

  it('deadlineFor() exposes the armed auto-deny moment and clears on cancel/fire', async () => {
    const clock = makeFakeClock()
    const scheduler = new ApprovalTimeoutScheduler(DEFAULT_APPROVAL_TIMEOUT_POLICY, () => {}, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn
    })
    expect(scheduler.deadlineFor('a1')).toBeUndefined()
    const before = Date.now()
    scheduler.schedule({ approvalId: 'a1', provider: 'codex' })
    const deadline = scheduler.deadlineFor('a1')
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 60_000)
    scheduler.cancel('a1')
    expect(scheduler.deadlineFor('a1')).toBeUndefined()

    scheduler.schedule({ approvalId: 'a2', provider: 'codex' })
    await clock.advance(60_000)
    expect(scheduler.deadlineFor('a2')).toBeUndefined()

    scheduler.schedule({ approvalId: 'a3', provider: 'codex' })
    scheduler.cancelAll()
    expect(scheduler.deadlineFor('a3')).toBeUndefined()
  })

  it('reason includes the source for caller logging', async () => {
    const clock = makeFakeClock()
    let captured: ApprovalTimeoutReason | undefined
    const scheduler = new ApprovalTimeoutScheduler(
      DEFAULT_APPROVAL_TIMEOUT_POLICY,
      (reason) => {
        captured = reason
      },
      { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }
    )
    scheduler.schedule({
      approvalId: 'a1',
      provider: 'codex',
      kind: 'hostCommand/rerun'
    })
    await clock.advance(180_000)
    expect(captured).toEqual({
      approvalId: 'a1',
      appliedMs: 180_000,
      source: 'perKind'
    })
  })
})
