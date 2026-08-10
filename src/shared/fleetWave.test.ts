import { describe, expect, it } from 'vitest'
import {
  fleetWaveDensityTier,
  fleetWaveExceptions,
  fleetWaveRoleRollup,
  groupPendingApprovalsByScope,
  type FleetWaveAgentState
} from './fleetWave'

describe('fleetWave helpers', () => {
  it('tiers by count at 6 / 7 / 20 / 21', () => {
    expect(fleetWaveDensityTier(0)).toBe('enumerate')
    expect(fleetWaveDensityTier(6)).toBe('enumerate')
    expect(fleetWaveDensityTier(7)).toBe('chips')
    expect(fleetWaveDensityTier(20)).toBe('chips')
    expect(fleetWaveDensityTier(21)).toBe('aggregate')
    expect(fleetWaveDensityTier(64)).toBe('aggregate')
  })

  it('names only failed and needs_approval as exceptions', () => {
    const agents: FleetWaveAgentState[] = [
      { id: '1', label: 'a', role: 'scout', status: 'completed' },
      { id: '2', label: 'b', role: 'worker', status: 'failed' },
      { id: '3', label: 'c', role: 'worker', status: 'needs_approval' },
      { id: '4', label: 'd', role: 'reviewer', status: 'working' }
    ]
    expect(fleetWaveExceptions(agents).map((a) => a.label)).toEqual(['b', 'c'])
  })

  it('rolls up by role', () => {
    const rollup = fleetWaveRoleRollup([
      { id: '1', label: 'a', role: 'scout', status: 'completed' },
      { id: '2', label: 'b', role: 'scout', status: 'completed' },
      { id: '3', label: 'c', role: 'worker', status: 'working' }
    ])
    expect(rollup.find((r) => r.role === 'scout')).toMatchObject({ total: 2, completed: 2 })
    expect(rollup.find((r) => r.role === 'worker')).toMatchObject({ total: 1, working: 1 })
  })

  it('groups approvals by scope for Allow-all', () => {
    const groups = groupPendingApprovalsByScope([
      { approvalId: '1', scopeKey: 'write:types', summary: 'a' },
      { approvalId: '2', scopeKey: 'write:types', summary: 'b' },
      { approvalId: '3', scopeKey: 'shell', summary: 'c' }
    ])
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.scopeKey === 'write:types')?.approvals).toHaveLength(2)
  })
})
