import { describe, expect, it } from 'vitest'

import {
  DEFERRED_HOST_MATERIALIZE_DELAY_MS,
  DEFERRED_HOST_MATERIALIZE_MAX_RESCHEDULES,
  DEFERRED_HOST_MATERIALIZE_MUTATION_THRESHOLD_BYTES
} from './hostChatCompatibilityDeferral'
import {
  HOST_MATERIALIZE_MAX_INTERVAL_MS,
  HOST_MATERIALIZE_MIN_INTERVAL_ENV,
  HOST_MATERIALIZE_MIN_INTERVAL_MS,
  HOST_MATERIALIZE_WORST_CASE_PUBLISH_LAG_MS,
  resolveHostMaterializeMinIntervalMs
} from './hostChatCompatibilityPolicy'

describe('Host compatibility checkpoint policy', () => {
  it('spaces chained full-record checkpoints by 30 s unless overridden', () => {
    expect(HOST_MATERIALIZE_MIN_INTERVAL_MS).toBe(30_000)
    expect(resolveHostMaterializeMinIntervalMs({})).toBe(30_000)
    expect(
      resolveHostMaterializeMinIntervalMs({ [HOST_MATERIALIZE_MIN_INTERVAL_ENV]: undefined })
    ).toBe(30_000)
  })

  it('reads the documented environment variable', () => {
    expect(HOST_MATERIALIZE_MIN_INTERVAL_ENV).toBe('TASKWRAITH_HOST_MATERIALIZE_MIN_INTERVAL_MS')
  })

  it.each([
    ['45000', 45_000],
    ['1500.9', 1_500],
    ['0', 0]
  ])('honours the override %s as %i ms (0 disables the wait)', (raw, expected) => {
    expect(resolveHostMaterializeMinIntervalMs({ [HOST_MATERIALIZE_MIN_INTERVAL_ENV]: raw })).toBe(
      expected
    )
  })

  it.each(['', '   ', 'soon', '-1', 'NaN', 'Infinity'])(
    'falls back to the default for the unusable override %j',
    (raw) => {
      expect(
        resolveHostMaterializeMinIntervalMs({ [HOST_MATERIALIZE_MIN_INTERVAL_ENV]: raw })
      ).toBe(HOST_MATERIALIZE_MIN_INTERVAL_MS)
    }
  )

  it('bounds the compound worst-case publish lag at 95 s and pins both of its components', () => {
    // 13 deferral fires (the first plus 12 below-gate reschedules) at 5 s,
    // then one 30 s interval for the successor that fire could only latch.
    // Raising any component moves this total and must be repinned on purpose.
    expect(DEFERRED_HOST_MATERIALIZE_DELAY_MS).toBe(5_000)
    expect(DEFERRED_HOST_MATERIALIZE_MAX_RESCHEDULES).toBe(12)
    expect(DEFERRED_HOST_MATERIALIZE_MUTATION_THRESHOLD_BYTES).toBe(512 * 1024)
    expect(HOST_MATERIALIZE_WORST_CASE_PUBLISH_LAG_MS).toBe(
      13 * DEFERRED_HOST_MATERIALIZE_DELAY_MS + HOST_MATERIALIZE_MIN_INTERVAL_MS
    )
    expect(HOST_MATERIALIZE_WORST_CASE_PUBLISH_LAG_MS).toBe(95_000)
  })

  it('caps an override at the ten-minute ceiling so a typo cannot strand external readers', () => {
    expect(HOST_MATERIALIZE_MAX_INTERVAL_MS).toBe(600_000)
    expect(
      resolveHostMaterializeMinIntervalMs({
        [HOST_MATERIALIZE_MIN_INTERVAL_ENV]: String(HOST_MATERIALIZE_MAX_INTERVAL_MS * 6)
      })
    ).toBe(HOST_MATERIALIZE_MAX_INTERVAL_MS)
  })
})
