import { describe, expect, it } from 'vitest'

import {
  HOST_MATERIALIZE_MAX_INTERVAL_MS,
  HOST_MATERIALIZE_MIN_INTERVAL_ENV,
  HOST_MATERIALIZE_MIN_INTERVAL_MS,
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

  it('caps an override at the ten-minute ceiling so a typo cannot strand external readers', () => {
    expect(HOST_MATERIALIZE_MAX_INTERVAL_MS).toBe(600_000)
    expect(
      resolveHostMaterializeMinIntervalMs({
        [HOST_MATERIALIZE_MIN_INTERVAL_ENV]: String(HOST_MATERIALIZE_MAX_INTERVAL_MS * 6)
      })
    ).toBe(HOST_MATERIALIZE_MAX_INTERVAL_MS)
  })
})
