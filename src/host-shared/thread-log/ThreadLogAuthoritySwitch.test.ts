import { afterEach, describe, expect, it, vi } from 'vitest'

import { isThreadLogAuthorityEnabled, THREAD_LOG_AUTHORITY_ENV } from './ThreadLogAuthoritySwitch'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('thread log authority switch', () => {
  it('is read from TASKWRAITH_THREAD_LOG_AUTHORITY', () => {
    expect(THREAD_LOG_AUTHORITY_ENV).toBe('TASKWRAITH_THREAD_LOG_AUTHORITY')
  })

  it('is on when the environment does not carry it', () => {
    expect(isThreadLogAuthorityEnabled({})).toBe(true)
    expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: undefined })).toBe(true)
  })

  it('is off for the exact token 0', () => {
    expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: '0' })).toBe(false)
  })

  it.each(['', '1', 'false', 'FALSE', 'off', 'no', ' 0', '0 ', '00', '0.0', '2', '10'])(
    'stays on for %j',
    (value) => {
      expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: value })).toBe(true)
    }
  )

  it('needs no durability switch beside it, and none of them turns it on or off', () => {
    const durability = [
      'TASKWRAITH_JOURNAL_FLUSHER',
      'TASKWRAITH_RUN_EVENT_FLUSHER',
      'TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY',
      'TASKWRAITH_JOURNAL_ROTATION',
      'TASKWRAITH_CHECKPOINT_WORKER',
      'TASKWRAITH_CHECKPOINT_PUBLICATION'
    ]
    const all = (value: string): Record<string, string> =>
      Object.fromEntries(durability.map((name) => [name, value]))
    expect(isThreadLogAuthorityEnabled(all('0'))).toBe(true)
    expect(isThreadLogAuthorityEnabled({ ...all('1'), [THREAD_LOG_AUTHORITY_ENV]: '0' })).toBe(false)
  })

  it('reads the process environment when it is given none', () => {
    vi.stubEnv(THREAD_LOG_AUTHORITY_ENV, '0')
    expect(isThreadLogAuthorityEnabled()).toBe(false)
    vi.stubEnv(THREAD_LOG_AUTHORITY_ENV, 'false')
    expect(isThreadLogAuthorityEnabled()).toBe(true)
  })
})
