import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import { sealOrphanExitRun } from './sealOrphanExitRun'

const NOW = '2026-07-12T14:00:00.000Z'

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return { runId: 'run-1', startedAt: '2026-07-12T13:59:00.000Z', ...overrides }
}

function chat(runs: ChatRun[]): ChatRecord {
  return { appChatId: 'chat-1', chatKind: 'single', runs } as unknown as ChatRecord
}

describe('sealOrphanExitRun', () => {
  it('seals an unsealed run matched by exact runId', () => {
    const c = chat([run()])
    const next = sealOrphanExitRun(c, 'run-1', {
      stats: { input_tokens: 16289, output_tokens: 211, total_tokens: 16500 },
      exitCode: 0,
      endedAt: NOW
    })
    const r = next.runs![0]
    expect(r.endedAt).toBe(NOW)
    expect(r.status).toBe('success')
    expect(r.exitCode).toBeUndefined() // exit 0 → no exitCode noise
    expect(r.stats).toEqual({ input_tokens: 16289, output_tokens: 211, total_tokens: 16500 })
  })

  it('marks a non-zero exit as failed and records the exit code', () => {
    const next = sealOrphanExitRun(chat([run()]), 'run-1', { exitCode: 1, endedAt: NOW })
    const r = next.runs![0]
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(1)
  })

  it('never clobbers a run that already sealed (endedAt present)', () => {
    const c = chat([run({ endedAt: '2026-07-12T13:59:30.000Z', status: 'success', stats: { a: 1 } })])
    const next = sealOrphanExitRun(c, 'run-1', {
      stats: { input_tokens: 99 },
      exitCode: 1,
      endedAt: NOW
    })
    expect(next).toBe(c) // untouched reference
    expect(next.runs![0].endedAt).toBe('2026-07-12T13:59:30.000Z')
    expect(next.runs![0].status).toBe('success')
  })

  it('preserves an existing status while still stamping endedAt', () => {
    const next = sealOrphanExitRun(chat([run({ status: 'success_with_warnings' })]), 'run-1', {
      exitCode: 0,
      endedAt: NOW
    })
    expect(next.runs![0].status).toBe('success_with_warnings')
    expect(next.runs![0].endedAt).toBe(NOW)
  })

  it('does not overwrite existing stats with exit stats', () => {
    const next = sealOrphanExitRun(chat([run({ stats: { input_tokens: 1 } })]), 'run-1', {
      stats: { input_tokens: 999 },
      exitCode: 0,
      endedAt: NOW
    })
    expect(next.runs![0].stats).toEqual({ input_tokens: 1 })
  })

  it('ignores non-object exit stats', () => {
    const next = sealOrphanExitRun(chat([run()]), 'run-1', {
      stats: [1, 2, 3],
      exitCode: 0,
      endedAt: NOW
    })
    expect(next.runs![0].stats).toBeUndefined()
  })

  it('returns the chat untouched when no run matches (never splices a foreign run)', () => {
    const c = chat([run({ runId: 'user-in-flight' })])
    const next = sealOrphanExitRun(c, 'foreign-audit-run', { exitCode: 0, endedAt: NOW })
    expect(next).toBe(c)
    expect(next.runs![0].runId).toBe('user-in-flight')
    expect(next.runs![0].endedAt).toBeUndefined()
  })

  it('no-ops without a runId', () => {
    const c = chat([run()])
    expect(sealOrphanExitRun(c, undefined, { exitCode: 0, endedAt: NOW })).toBe(c)
  })
})
