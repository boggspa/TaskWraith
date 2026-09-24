import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  CONTROL_ACTION_HOST_COMMANDS,
  runControlActionReplay,
  runDryRun
} = require('./controlActionReplay.cjs')
const { CONTROL_ACTIONS } = require('./interferenceMatrix.cjs')

function target(chatId: string) {
  return { chatId }
}

function entry(
  seq: number,
  action: string,
  chatId = 'chat-light',
  extra: Record<string, unknown> = {}
) {
  return { seq, action, target: target(chatId), ...extra }
}

function okApi(log: string[] = []) {
  return {
    async issueControlAction(call: { action: string; target: { chatId: string } }) {
      log.push(`${call.action}:${call.target.chatId}`)
      return { ok: true }
    }
  }
}

function clock(readings: number[]) {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)]
}

describe('control-action replay driver (Wall 1)', () => {
  it('maps every control action onto its dispatched Host command', () => {
    expect(Object.keys(CONTROL_ACTION_HOST_COMMANDS).sort()).toEqual([...CONTROL_ACTIONS].sort())
    expect(CONTROL_ACTION_HOST_COMMANDS).toEqual({
      cancel: 'run.cancel',
      approval_decision: 'approval.decide',
      question_answer: 'question.answer',
      seat_toggle: 'ensemble.seat.toggle'
    })
  })

  it('executes the schedule sequentially in array order with measured latencies', async () => {
    const log: string[] = []
    // startedAt, action readings (start/end pairs), endedAt.
    const nowMs = clock([1000, 1010, 1025, 1030, 1060, 1070, 1075])
    const result = await runControlActionReplay({
      api: okApi(log),
      schedule: [entry(3, 'cancel'), entry(1, 'seat_toggle')],
      nowMs
    })
    expect(log).toEqual(['cancel:chat-light', 'seat_toggle:chat-light'])
    expect(result.ok).toBe(true)
    expect(result.status).toBe('complete')
    expect(result.actions.map((action: { seq: number }) => action.seq)).toEqual([3, 1])
    expect(result.actions[0].latencyMs).toBe(15)
    expect(result.actions[1].latencyMs).toBe(30)
    expect(result.latencies).toMatchObject({ count: 2, p50: 15, p95: 30, p99: 30, max: 30 })
    expect(result.elapsedMs).toBe(70)
  })

  it('continues after failed and unsupported actions; failed wins the status', async () => {
    const api = {
      issueControlAction(call: { action: string }) {
        if (call.action === 'cancel') throw new Error('boom-payload-must-not-leak')
        if (call.action === 'question_answer') return { unsupported: 'no_pending_question' }
        return { ok: true }
      }
    }
    const result = await runControlActionReplay({
      api,
      schedule: [
        entry(1, 'seat_toggle'),
        entry(2, 'cancel'),
        entry(3, 'question_answer'),
        entry(4, 'approval_decision')
      ],
      nowMs: clock([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    })
    expect(result.actions.map((action: { outcome: string }) => action.outcome)).toEqual([
      'completed',
      'failed',
      'unsupported',
      'completed'
    ])
    expect(result.actions[1].reason).toBe('action_threw')
    expect(JSON.stringify(result)).not.toContain('boom-payload-must-not-leak')
    expect(result.actions[2].reason).toBe('no_pending_question')
    expect(result.unsupported).toEqual(['no_pending_question'])
    expect(result.status).toBe('failed')
    expect(result.ok).toBe(false)
  })

  it('fails closed on malformed adapter results and accepts sync returns', async () => {
    const api = {
      issueControlAction(call: { action: string }) {
        if (call.action === 'cancel') return { ok: true }
        if (call.action === 'approval_decision') return null
        if (call.action === 'question_answer') return { ok: 'yes' }
        return undefined
      }
    }
    const result = await runControlActionReplay({
      api,
      schedule: [
        entry(1, 'cancel'),
        entry(2, 'approval_decision'),
        entry(3, 'question_answer'),
        entry(4, 'seat_toggle')
      ],
      nowMs: clock([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    })
    expect(result.actions.map((action: { outcome: string }) => action.outcome)).toEqual([
      'completed',
      'failed',
      'failed',
      'failed'
    ])
    expect(result.actions[1].reason).toBe('action_invalid_result')
    expect(result.status).toBe('failed')
  })

  it('issues exactly one api call per attempted action — no silent retries', async () => {
    let calls = 0
    const api = {
      async issueControlAction() {
        calls += 1
        throw new Error('down')
      }
    }
    const result = await runControlActionReplay({
      api,
      schedule: [entry(1, 'cancel'), entry(2, 'cancel')],
      nowMs: clock([0, 1, 2, 3, 4, 5])
    })
    expect(calls).toBe(2)
    expect(result.actions.every((action: { apiCalls: number }) => action.apiCalls === 1)).toBe(true)
    expect(result.actions.map((action: { reason: string }) => action.reason)).toEqual([
      'action_rejected',
      'action_rejected'
    ])
  })

  it('times out a hung action, reports the pending effect, and stops the schedule', async () => {
    const api = { issueControlAction: () => new Promise(() => {}) }
    const result = await runControlActionReplay({
      api,
      schedule: [entry(1, 'cancel'), entry(2, 'seat_toggle')],
      actionTimeoutMs: 15
    })
    expect(result.actions[0].outcome).toBe('failed')
    expect(result.actions[0].reason).toBe('action_timeout')
    expect(result.actions[0].pendingEffect).toBe(true)
    expect(result.actions[1].outcome).toBe('not_attempted')
    expect(result.pendingEffects).toEqual([{ seq: 1, action: 'cancel', chatId: 'chat-light' }])
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('action_timeout')
  })

  it('censors the remainder when the deadline passes between actions', async () => {
    // Fake clock jumps past the 100ms deadline after the first action; the
    // real 10s deadline timer never fires inside the test.
    const nowMs = clock([0, 10, 20, 5000, 5000, 5000])
    const result = await runControlActionReplay({
      api: okApi(),
      schedule: [entry(1, 'cancel'), entry(2, 'seat_toggle')],
      deadlineMs: 100,
      nowMs
    })
    expect(result.actions.map((action: { outcome: string }) => action.outcome)).toEqual([
      'completed',
      'not_attempted'
    ])
    expect(result.status).toBe('censored')
    expect(result.reason).toBe('deadline')
  })

  it('marks the run incomplete when the deadline cuts an in-flight action', async () => {
    const api = { issueControlAction: () => new Promise(() => {}) }
    const result = await runControlActionReplay({
      api,
      schedule: [entry(1, 'cancel'), entry(2, 'seat_toggle')],
      deadlineMs: 15
    })
    expect(result.actions[0].outcome).toBe('censored')
    expect(result.actions[0].reason).toBe('deadline')
    expect(result.actions[0].pendingEffect).toBe(true)
    expect(result.actions[1].outcome).toBe('not_attempted')
    expect(result.status).toBe('incomplete')
  })

  it('fails the run when the clock regresses', async () => {
    const nowMs = clock([100, 90, 90, 90])
    const result = await runControlActionReplay({
      api: okApi(),
      schedule: [entry(1, 'cancel')],
      nowMs
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('clock_invalid')
  })

  it('refuses a second concurrent run over the same chat, then releases it', async () => {
    let release!: () => void
    const gate = new Promise<{ ok: boolean }>((resolve) => {
      release = () => resolve({ ok: true })
    })
    const api = { issueControlAction: () => gate }
    const first = runControlActionReplay({ api, schedule: [entry(1, 'cancel')] })
    await expect(
      runControlActionReplay({ api, schedule: [entry(2, 'seat_toggle')] })
    ).rejects.toThrow(/still owned/)
    release()
    await expect(first).resolves.toMatchObject({ status: 'complete' })
    await expect(
      runControlActionReplay({ api: okApi(), schedule: [entry(3, 'cancel')] })
    ).resolves.toMatchObject({ status: 'complete' })
  })

  it('refuses malformed options instead of running a misleading schedule', async () => {
    const api = okApi()
    await expect(runControlActionReplay(null)).rejects.toThrow(/options required/)
    await expect(runControlActionReplay({ api, schedule: [] })).rejects.toThrow(/schedule/)
    await expect(
      runControlActionReplay({ api, schedule: [entry(1, 'cancel'), entry(1, 'cancel')] })
    ).rejects.toThrow(/unique/)
    await expect(runControlActionReplay({ api, schedule: [entry(1, 'launch')] })).rejects.toThrow(
      /action/
    )
    await expect(
      runControlActionReplay({ api, schedule: [{ seq: 1, action: 'cancel', target: {} }] })
    ).rejects.toThrow(/chatId/)
    await expect(runControlActionReplay({ schedule: [entry(1, 'cancel')] })).rejects.toThrow(/api/)
    await expect(
      runControlActionReplay({ api, schedule: [entry(1, 'cancel')], actionTimeoutMs: 0 })
    ).rejects.toThrow(/actionTimeoutMs/)
    await expect(
      runControlActionReplay({ api, schedule: [entry(1, 'cancel')], deadlineMs: -5 })
    ).rejects.toThrow(/deadlineMs/)
    await expect(
      runControlActionReplay({
        api,
        schedule: [entry(1, 'cancel')],
        timers: { setTimeout: () => 0 }
      })
    ).rejects.toThrow(/timers/)
  })

  it('marks a clean diagnostic run without qualifying it', async () => {
    const result = await runControlActionReplay({
      api: okApi(),
      schedule: [entry(1, 'cancel')],
      diagnosticOnly: true,
      nowMs: clock([0, 5, 10])
    })
    expect(result.status).toBe('diagnostic')
    expect(result.ok).toBe(false)
  })

  it('dry-run proves the driver over all four actions with a fake adapter', async () => {
    const result = await runDryRun()
    expect(result.actions.map((action: { action: string }) => action.action)).toEqual([
      'cancel',
      'approval_decision',
      'question_answer',
      'seat_toggle'
    ])
    expect(
      result.actions.every((action: { outcome: string }) => action.outcome === 'completed')
    ).toBe(true)
    expect(result.status).toBe('diagnostic')
  })
})
