/**
 * Host Arc Track4 Mixed Wave A — HostProductionParticipantShadow pins.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionParticipantShadow,
  mapParticipantShadowsToHostParticipants,
  type HostParticipantShadowEntry
} from './HostProductionParticipantShadow'

function entry(overrides: Partial<HostParticipantShadowEntry> = {}): HostParticipantShadowEntry {
  return {
    id: 'p-1',
    providerId: 'codex',
    role: 'Worker',
    order: 1,
    enabled: true,
    active: false,
    modelId: 'gpt-5.6',
    stage: 'worker',
    status: 'idle',
    ...overrides
  }
}

describe('mapParticipantShadowsToHostParticipants', () => {
  it('returns empty for zero entries (a measured none)', () => {
    expect(mapParticipantShadowsToHostParticipants([])).toEqual([])
  })

  it('keeps the participant id verbatim — it is the client join key', () => {
    const rows = mapParticipantShadowsToHostParticipants([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('p-1')
    expect(rows[0].providerId).toBe('codex')
  })

  it('carries required role/order/enabled/active and optional model/stage/status', () => {
    const rows = mapParticipantShadowsToHostParticipants([entry({ active: true })])
    expect(rows[0]).toMatchObject({
      role: 'Worker',
      order: 1,
      enabled: true,
      active: true,
      modelId: 'gpt-5.6',
      stage: 'worker',
      status: 'idle'
    })
  })

  it('omits optional model/stage/status when absent', () => {
    const rows = mapParticipantShadowsToHostParticipants([
      entry({ modelId: undefined, stage: undefined, status: undefined })
    ])
    expect('modelId' in rows[0]).toBe(false)
    expect('stage' in rows[0]).toBe(false)
    expect('status' in rows[0]).toBe(false)
  })

  it('skips rows without usable id or providerId', () => {
    const rows = mapParticipantShadowsToHostParticipants([
      entry({ id: '' }),
      entry({ id: '   ' }),
      entry({ providerId: '' }),
      entry({ id: 'y'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('skips rows with empty role or non-boolean enabled/active', () => {
    const rows = mapParticipantShadowsToHostParticipants([
      entry({ role: '' }),
      entry({ role: '   ' }),
      entry({ enabled: undefined as unknown as boolean }),
      entry({ active: undefined as unknown as boolean })
    ])
    expect(rows).toEqual([])
  })

  it('skips rows with invalid order', () => {
    const rows = mapParticipantShadowsToHostParticipants([
      entry({ order: -1 }),
      entry({ order: 1.5 }),
      entry({ order: Number.NaN })
    ])
    expect(rows).toEqual([])
  })

  it('bounds over-long role/status rather than forwarding them', () => {
    const rows = mapParticipantShadowsToHostParticipants([
      entry({ role: 'r'.repeat(5000), status: 's'.repeat(5000) })
    ])
    expect(rows[0].role.length).toBeLessThanOrEqual(200)
    expect(rows[0].status!.length).toBeLessThanOrEqual(200)
  })

  it('omits unknown stage rather than inventing one', () => {
    const rows = mapParticipantShadowsToHostParticipants([entry({ stage: 'boss' })])
    expect('stage' in rows[0]).toBe(false)
  })

  it('allowlists only HostParticipantProjection keys (no instructions leakage)', () => {
    const smuggled = {
      ...entry(),
      instructions: 'DO NOT LEAK',
      permissionPresetId: 'full-access'
    } as HostParticipantShadowEntry & { instructions: string; permissionPresetId: string }
    const rows = mapParticipantShadowsToHostParticipants([smuggled])
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'active',
        'enabled',
        'id',
        'modelId',
        'order',
        'providerId',
        'role',
        'stage',
        'status'
      ].sort()
    )
    expect(JSON.stringify(rows[0])).not.toContain('DO NOT LEAK')
    expect(JSON.stringify(rows[0])).not.toContain('full-access')
  })
})

describe('createHostProductionParticipantShadow', () => {
  it('re-reads listParticipants on every call', () => {
    const listParticipants = vi
      .fn()
      .mockReturnValueOnce([entry({ id: 'a' })])
      .mockReturnValueOnce([entry({ id: 'b' }), entry({ id: 'c' })])
    const port = createHostProductionParticipantShadow({ listParticipants })
    expect(port.listParticipants()).toHaveLength(1)
    expect(port.listParticipants()).toHaveLength(2)
    expect(listParticipants).toHaveBeenCalledTimes(2)
  })

  it('propagates listParticipants throws (fail closed)', () => {
    const port = createHostProductionParticipantShadow({
      listParticipants: () => {
        throw new Error('roster unavailable')
      }
    })
    expect(() => port.listParticipants()).toThrow('roster unavailable')
  })

  it('rejects a missing listParticipants dependency', () => {
    expect(() =>
      createHostProductionParticipantShadow({
        listParticipants: undefined as unknown as () => HostParticipantShadowEntry[]
      })
    ).toThrow(/listParticipants/)
  })
})
