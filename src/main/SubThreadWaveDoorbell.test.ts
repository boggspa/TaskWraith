import { describe, expect, it } from 'vitest'
import {
  FLEET_DOORBELL_MAX_NAMED_WAVES,
  FLEET_DOORBELL_MAX_VALUE_LEN,
  buildFleetDoorbellValue,
  isDoorbellReadyWave,
  shouldRefreshDoorbell,
  type FleetDoorbellWave
} from './SubThreadWaveDoorbell'

function wave(overrides: Partial<FleetDoorbellWave> & { waveId: string }): FleetDoorbellWave {
  return { total: 3, settled: 3, ...overrides }
}

describe('isDoorbellReadyWave', () => {
  it('rings only once every worker can no longer return', () => {
    expect(isDoorbellReadyWave(wave({ waveId: 'w', total: 3, settled: 3 }))).toBe(true)
    expect(isDoorbellReadyWave(wave({ waveId: 'w', total: 3, settled: 2 }))).toBe(false)
    // A wave with no workers is not a settled wave.
    expect(isDoorbellReadyWave(wave({ waveId: 'w', total: 0, settled: 0 }))).toBe(false)
  })
})

describe('buildFleetDoorbellValue', () => {
  it('announces nothing while every wave is still running', () => {
    expect(buildFleetDoorbellValue([wave({ waveId: 'w1', total: 4, settled: 1 })])).toBeNull()
  })

  it('names an unclaimed settled wave and how to take it', () => {
    const value = buildFleetDoorbellValue([wave({ waveId: 'wave-7', total: 5, settled: 5 })])
    expect(value).toContain('1 settled fleet wave, 1 unclaimed.')
    expect(value).toContain('wave-7 (5 agents) — unclaimed')
    expect(value).toContain('claim_fleet_wave({waveId})')
  })

  it('distinguishes a deliberate claim from the spawner auto-claim', () => {
    const value = buildFleetDoorbellValue([
      wave({ waveId: 'w1', claimedBy: 'seat-a', claimAuto: true }),
      wave({ waveId: 'w2', claimedBy: 'seat-b' })
    ])
    expect(value).toContain('w1 (3 agents) — held by spawner seat-a')
    expect(value).toContain('w2 (3 agents) — claimed by seat-b')
    expect(value).toContain('all claimed.')
  })

  it('carries pointers only — never worker output', () => {
    const value = buildFleetDoorbellValue([wave({ waveId: 'w1' })]) || ''
    expect(value).not.toContain('findings')
    expect(value.length).toBeLessThanOrEqual(FLEET_DOORBELL_MAX_VALUE_LEN)
  })

  it('collapses a large fleet into a bounded notice', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      wave({ waveId: `wave-parent-1-${index}` })
    )
    const value = buildFleetDoorbellValue(many) || ''
    expect(value.length).toBeLessThanOrEqual(FLEET_DOORBELL_MAX_VALUE_LEN)
    expect(value).toContain(`+${40 - FLEET_DOORBELL_MAX_NAMED_WAVES} more settled waves.`)
    expect(value).toContain('40 settled fleet waves, 40 unclaimed.')
  })

  it('stays inside the value cap even for pathologically long wave ids', () => {
    const long = Array.from({ length: 8 }, (_, index) =>
      wave({ waveId: `wave-${'x'.repeat(300)}-${index}`, claimedBy: 'y'.repeat(120) })
    )
    const value = buildFleetDoorbellValue(long) || ''
    expect(value.length).toBeLessThanOrEqual(FLEET_DOORBELL_MAX_VALUE_LEN)
  })
})

describe('shouldRefreshDoorbell', () => {
  it('does not re-ring for an unchanged notice', () => {
    const value = buildFleetDoorbellValue([wave({ waveId: 'w1' })])
    expect(shouldRefreshDoorbell(value ?? undefined, value)).toBe(false)
  })

  it('re-rings when the notice actually changes', () => {
    const before = buildFleetDoorbellValue([wave({ waveId: 'w1' })])
    const after = buildFleetDoorbellValue([wave({ waveId: 'w1' }), wave({ waveId: 'w2' })])
    expect(shouldRefreshDoorbell(before ?? undefined, after)).toBe(true)
  })

  it('removes a standing notice once nothing is left to announce', () => {
    const existing = buildFleetDoorbellValue([wave({ waveId: 'w1' })])
    expect(shouldRefreshDoorbell(existing ?? undefined, null)).toBe(true)
  })

  it('stays quiet when there is no notice and nothing to say', () => {
    expect(shouldRefreshDoorbell(undefined, null)).toBe(false)
    expect(shouldRefreshDoorbell('', null)).toBe(false)
  })
})
