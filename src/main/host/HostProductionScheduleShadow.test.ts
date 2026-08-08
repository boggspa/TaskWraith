/**
 * Host Arc Track3 Mixed Wave A — HostProductionScheduleShadow pins.
 *
 * RED-first discipline matches HostProductionQuestionShadow /
 * HostProductionApprovalShadow: pins assert the mapping contract
 * before (and after) the adapter lands.
 *
 * WHAT IS BEING PINNED. Scheduled tasks and workflows live in AppStore
 * keyed by a store-minted id. Host schedule cards on the wire reuse that
 * id so clients can join. The adapter maps only allowlisted fields —
 * scheduleId, title, enabled, optional nextFireAt/threadId — and never
 * forwards prompt bodies onto the wire.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionScheduleShadow,
  mapScheduleShadowsToHostSchedules,
  type HostScheduleShadowEntry
} from './HostProductionScheduleShadow'

function entry(overrides: Partial<HostScheduleShadowEntry> = {}): HostScheduleShadowEntry {
  return {
    scheduleId: 'sched-1700000000000-abc123',
    title: 'Morning standup briefing',
    enabled: true,
    nextFireAt: 1_700_000_000_000,
    threadId: 'chat-1',
    ...overrides
  }
}

describe('mapScheduleShadowsToHostSchedules', () => {
  it('returns empty for zero entries (a measured none)', () => {
    expect(mapScheduleShadowsToHostSchedules([])).toEqual([])
  })

  it('keeps the scheduleId verbatim — it is the client join key', () => {
    const rows = mapScheduleShadowsToHostSchedules([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].scheduleId).toBe('sched-1700000000000-abc123')
  })

  it('carries required title and enabled', () => {
    const rows = mapScheduleShadowsToHostSchedules([entry({ enabled: false })])
    expect(rows[0].title).toBe('Morning standup briefing')
    expect(rows[0].enabled).toBe(false)
  })

  it('carries optional nextFireAt and threadId when present and valid', () => {
    const rows = mapScheduleShadowsToHostSchedules([entry()])
    expect(rows[0].nextFireAt).toBe(1_700_000_000_000)
    expect(rows[0].threadId).toBe('chat-1')
  })

  it('omits optional nextFireAt / threadId when absent', () => {
    const rows = mapScheduleShadowsToHostSchedules([
      entry({ nextFireAt: undefined, threadId: undefined })
    ])
    expect('nextFireAt' in rows[0]).toBe(false)
    expect('threadId' in rows[0]).toBe(false)
  })

  it('skips rows without a usable scheduleId', () => {
    const rows = mapScheduleShadowsToHostSchedules([
      entry({ scheduleId: '' }),
      entry({ scheduleId: '   ' }),
      entry({ scheduleId: 'y'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('skips rows with empty title', () => {
    const rows = mapScheduleShadowsToHostSchedules([entry({ title: '' }), entry({ title: '   ' })])
    expect(rows).toEqual([])
  })

  it('skips rows whose enabled is not a boolean', () => {
    const rows = mapScheduleShadowsToHostSchedules([
      entry({ enabled: undefined as unknown as boolean }),
      // @ts-expect-error — intentional bad shape
      entry({ enabled: 'true' })
    ])
    expect(rows).toEqual([])
  })

  it('bounds an over-long title rather than forwarding it', () => {
    const rows = mapScheduleShadowsToHostSchedules([entry({ title: 'x'.repeat(5000) })])
    expect(rows[0].title.length).toBeLessThanOrEqual(200)
  })

  it('omits invalid nextFireAt rather than inventing one', () => {
    const rows = mapScheduleShadowsToHostSchedules([
      entry({ nextFireAt: Number.NaN }),
      entry({ nextFireAt: -1 }),
      entry({ nextFireAt: 1.5 })
    ])
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect('nextFireAt' in row).toBe(false)
    }
  })

  it('omits unusable threadId rather than inventing one', () => {
    const rows = mapScheduleShadowsToHostSchedules([
      entry({ threadId: '' }),
      entry({ threadId: '   ' }),
      entry({ threadId: 'z'.repeat(4096) })
    ])
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect('threadId' in row).toBe(false)
    }
  })

  it('allowlists fields — no prompt body leak onto the wire', () => {
    const dirty = {
      ...entry(),
      prompt: 'SECRET PROMPT BODY that must never ship',
      displayPrompt: 'also secret'
    } as HostScheduleShadowEntry & { prompt: string; displayPrompt: string }
    const rows = mapScheduleShadowsToHostSchedules([dirty])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['enabled', 'nextFireAt', 'scheduleId', 'threadId', 'title'].sort()
    )
    expect(JSON.stringify(rows[0])).not.toContain('SECRET')
    expect(JSON.stringify(rows[0])).not.toContain('prompt')
  })
})

describe('createHostProductionScheduleShadow', () => {
  it('requires a listSchedules function', () => {
    expect(() => createHostProductionScheduleShadow({} as never)).toThrow(
      'HostProductionScheduleShadow requires listSchedules to be a function'
    )
  })

  it('reads live on every listSchedules call (no caching of a moving set)', () => {
    const listSchedules = vi.fn(() => [entry()])
    const port = createHostProductionScheduleShadow({ listSchedules })
    expect(port.listSchedules()).toHaveLength(1)
    expect(port.listSchedules()).toHaveLength(1)
    expect(listSchedules).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionScheduleShadow({
      listSchedules: () => {
        throw new Error('schedule registry unavailable')
      }
    })
    expect(() => port.listSchedules()).toThrow('schedule registry unavailable')
  })
})
