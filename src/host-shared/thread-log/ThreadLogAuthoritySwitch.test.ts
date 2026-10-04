import { afterEach, describe, expect, it, vi } from 'vitest'

import { isThreadLogAuthorityEnabled, THREAD_LOG_AUTHORITY_ENV } from './ThreadLogAuthoritySwitch'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('thread log authority switch', () => {
  it('is read from TASKWRAITH_THREAD_LOG_AUTHORITY', () => {
    expect(THREAD_LOG_AUTHORITY_ENV).toBe('TASKWRAITH_THREAD_LOG_AUTHORITY')
  })

  it('is off when the environment does not carry it', () => {
    expect(isThreadLogAuthorityEnabled({})).toBe(false)
    expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: undefined })).toBe(false)
  })

  it('is on for the exact token 1', () => {
    expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: '1' })).toBe(true)
  })

  it.each(['', '0', 'true', 'TRUE', 'on', 'yes', ' 1', '1 ', '01', '1.0', '2', '11'])(
    'stays off for %j',
    (value) => {
      expect(isThreadLogAuthorityEnabled({ [THREAD_LOG_AUTHORITY_ENV]: value })).toBe(false)
    }
  )

  it('needs no durability switch beside it, and none of them turns it on', () => {
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
    expect(isThreadLogAuthorityEnabled({ ...all('0'), [THREAD_LOG_AUTHORITY_ENV]: '1' })).toBe(true)
    expect(isThreadLogAuthorityEnabled(all('1'))).toBe(false)
  })

  it('reads the process environment when it is given none', () => {
    vi.stubEnv(THREAD_LOG_AUTHORITY_ENV, '1')
    expect(isThreadLogAuthorityEnabled()).toBe(true)
    vi.stubEnv(THREAD_LOG_AUTHORITY_ENV, 'true')
    expect(isThreadLogAuthorityEnabled()).toBe(false)
  })
})
