import { describe, expect, it } from 'vitest'
import type { NativeCapabilitySnapshot } from '../../../main/NativeCapabilities'
import {
  deriveEnsembleConcurrentLanesAvailable,
  deriveEnsembleConcurrentWriteLanesAvailable,
  deriveScreenWatchUnavailableReason
} from './useNativeCapabilities'

const baseSnapshot = (overrides: Partial<NativeCapabilitySnapshot> = {}): NativeCapabilitySnapshot =>
  ({
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '24.0.0',
    bridge: { available: true },
    screenWatch: { available: true },
    appwatch: { available: true },
    ocr: { available: true },
    appleEvents: { available: true },
    featureGates: {
      concurrentLanes: true,
      concurrentWriteLanes: false
    },
    ...overrides
  }) as NativeCapabilitySnapshot

describe('deriveEnsembleConcurrentLanesAvailable', () => {
  it('defaults to true when capabilities are unknown', () => {
    expect(deriveEnsembleConcurrentLanesAvailable(null)).toBe(true)
  })

  it('reads concurrentLanes from the snapshot', () => {
    expect(
      deriveEnsembleConcurrentLanesAvailable(
        baseSnapshot({ featureGates: { concurrentLanes: false, concurrentWriteLanes: false } })
      )
    ).toBe(false)
  })
})

describe('deriveEnsembleConcurrentWriteLanesAvailable', () => {
  it('defaults to false when capabilities are unknown', () => {
    expect(deriveEnsembleConcurrentWriteLanesAvailable(null)).toBe(false)
  })

  it('reads concurrentWriteLanes from the snapshot', () => {
    expect(
      deriveEnsembleConcurrentWriteLanesAvailable(
        baseSnapshot({ featureGates: { concurrentLanes: true, concurrentWriteLanes: true } })
      )
    ).toBe(true)
  })
})

describe('deriveScreenWatchUnavailableReason', () => {
  it('returns null when screen watch is available', () => {
    expect(deriveScreenWatchUnavailableReason(baseSnapshot())).toBeNull()
  })

  it('returns null while capabilities are still loading', () => {
    expect(deriveScreenWatchUnavailableReason(null)).toBeNull()
  })

  it('uses the snapshot reason when screen watch is unavailable', () => {
    expect(
      deriveScreenWatchUnavailableReason(
        baseSnapshot({ screenWatch: { available: false, reason: 'Requires macOS 15.' } })
      )
    ).toBe('Requires macOS 15.')
  })

  it('falls back to the v1 default message when no reason is provided', () => {
    expect(
      deriveScreenWatchUnavailableReason(baseSnapshot({ screenWatch: { available: false } }))
    ).toBe('Appwatch/Appshots are macOS-only in v1.')
  })
})