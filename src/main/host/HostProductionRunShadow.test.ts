/**
 * Host Arc Track3 Mixed Wave A — HostProductionRunShadow pins.
 *
 * RED-first discipline matches HostProductionQuestionShadow /
 * HostProductionApprovalShadow: pins assert the mapping contract before
 * (and after) the adapter lands.
 *
 * WHAT IS BEING PINNED. Active runs (RunManager / equivalent) shadow into
 * HostRunProjection allowlist fields only. threadId is required on the wire —
 * never invent it. usage is never fabricated on this path.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionRunShadow,
  mapActiveRunShadowsToHostRuns,
  type HostActiveRunShadowEntry
} from './HostProductionRunShadow'

function entry(overrides: Partial<HostActiveRunShadowEntry> = {}): HostActiveRunShadowEntry {
  return {
    runId: 'run-1',
    threadId: 'chat-1',
    providerId: 'codex',
    status: 'running',
    ...overrides
  }
}

describe('mapActiveRunShadowsToHostRuns', () => {
  it('returns empty for zero active entries (a measured none)', () => {
    expect(mapActiveRunShadowsToHostRuns([])).toEqual([])
  })

  it('maps a happy-path active run onto HostRunProjection allowlist fields', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({
        runId: 'run-42',
        threadId: 'chat-9',
        providerId: 'claude',
        status: 'running',
        startedAt: 1_700_000_000_000,
        modelId: 'claude-sonnet-4-7'
      })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      runId: 'run-42',
      threadId: 'chat-9',
      providerId: 'claude',
      providerOutcome: 'running',
      startedAt: 1_700_000_000_000,
      modelId: 'claude-sonnet-4-7'
    })
  })

  it('accepts appChatId as the threadId source when threadId is absent', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ threadId: undefined, appChatId: 'chat-from-app' })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].threadId).toBe('chat-from-app')
  })

  it('skips rows missing required runId / threadId / providerId — never invents threadId', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ runId: '' }),
      entry({ runId: '   ' }),
      entry({ threadId: undefined, appChatId: undefined }),
      entry({ threadId: '', appChatId: '' }),
      entry({ threadId: '   ', appChatId: '   ' }),
      entry({ providerId: '' }),
      entry({ providerId: '   ' })
    ])
    expect(rows).toEqual([])
  })

  it('maps starting → running', () => {
    const rows = mapActiveRunShadowsToHostRuns([entry({ status: 'starting' })])
    expect(rows[0].providerOutcome).toBe('running')
  })

  it('maps known terminal statuses and requires_action only when evidenced', () => {
    expect(mapActiveRunShadowsToHostRuns([entry({ status: 'completed' })])[0].providerOutcome).toBe(
      'completed'
    )
    expect(mapActiveRunShadowsToHostRuns([entry({ status: 'failed' })])[0].providerOutcome).toBe(
      'failed'
    )
    expect(mapActiveRunShadowsToHostRuns([entry({ status: 'cancelled' })])[0].providerOutcome).toBe(
      'cancelled'
    )
    expect(
      mapActiveRunShadowsToHostRuns([entry({ status: 'requires_action' })])[0].providerOutcome
    ).toBe('requires_action')
    expect(
      mapActiveRunShadowsToHostRuns([
        entry({ providerOutcome: 'requires_action', status: undefined })
      ])[0].providerOutcome
    ).toBe('requires_action')
  })

  it('maps unmapped statuses to unknown — never invents requires_action', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ status: 'queued' }),
      entry({ status: 'paused' }),
      entry({ status: 'something-else' })
    ])
    expect(rows.map((r) => r.providerOutcome)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('prefers an explicit providerOutcome when it is a known wire outcome', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ providerOutcome: 'failed', status: 'running' })
    ])
    expect(rows[0].providerOutcome).toBe('failed')
  })

  it('carries optional endedAt when present and valid', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ status: 'completed', endedAt: 1_700_000_100_000 })
    ])
    expect(rows[0].endedAt).toBe(1_700_000_100_000)
  })

  it('never invents usage on the run shadow path', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({
        // Foreign/extra field — must not leak or fabricate usage.
        ...({ usage: { inputTokens: 99, confidence: 'exact' } } as object)
      } as HostActiveRunShadowEntry)
    ])
    expect(rows).toHaveLength(1)
    expect('usage' in rows[0]).toBe(false)
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['providerId', 'providerOutcome', 'runId', 'threadId'].sort()
    )
  })

  it('allowlists fields — no foreign run metadata leaks onto the wire', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      entry({
        startedAt: 10,
        endedAt: 20,
        modelId: 'gpt-5.6'
      })
    ])
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'endedAt',
        'modelId',
        'providerId',
        'providerOutcome',
        'runId',
        'startedAt',
        'threadId'
      ].sort()
    )
  })

  it('skips rows whose ids cannot carry within the wire bound', () => {
    const tooLong = 'y'.repeat(4096)
    const rows = mapActiveRunShadowsToHostRuns([
      entry({ runId: tooLong }),
      entry({ threadId: tooLong }),
      entry({ providerId: tooLong })
    ])
    expect(rows).toEqual([])
  })
})

describe('createHostProductionRunShadow', () => {
  it('requires a listActive function', () => {
    expect(() => createHostProductionRunShadow({} as never)).toThrow(
      'HostProductionRunShadow requires listActive to be a function'
    )
  })

  it('reads live on every listRuns call (no caching of a moving set)', () => {
    const listActive = vi.fn(() => [entry()])
    const port = createHostProductionRunShadow({ listActive })
    expect(port.listRuns()).toHaveLength(1)
    expect(port.listRuns()).toHaveLength(1)
    expect(listActive).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionRunShadow({
      listActive: () => {
        throw new Error('run manager unavailable')
      }
    })
    expect(() => port.listRuns()).toThrow('run manager unavailable')
  })

  it('returns a HostProductionRunListPort shape (listRuns)', () => {
    const port = createHostProductionRunShadow({ listActive: () => [entry()] })
    expect(typeof port.listRuns).toBe('function')
    expect(port.listRuns()[0].runId).toBe('run-1')
  })
})
