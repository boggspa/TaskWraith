import { afterEach, describe, expect, it, vi } from 'vitest'

import { THREAD_LOG_AUTHORITY_ENV } from '../../host-shared/thread-log/ThreadLogAuthoritySwitch'
import {
  CHECKPOINT_PUBLICATION_ENV,
  FLUSHER_DURABILITY_ENVS,
  isThreadBarrierDurabilityRequested,
  resolveThreadDurabilitySwitches,
  THREAD_BARRIER_DURABILITY_ENV
} from './ThreadBarrierDurabilitySwitch'

afterEach(() => {
  vi.unstubAllEnvs()
})

const BARRIER = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'
const AUTHORITY = 'TASKWRAITH_THREAD_LOG_AUTHORITY'
const FLUSHERS = [
  'TASKWRAITH_JOURNAL_FLUSHER',
  'TASKWRAITH_RUN_EVENT_FLUSHER',
  'TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY'
]
const PUBLICATION = 'TASKWRAITH_CHECKPOINT_PUBLICATION'
const WORKER = 'TASKWRAITH_CHECKPOINT_WORKER'

function resolve(env: Record<string, string | undefined>) {
  const warnings: string[] = []
  const switches = resolveThreadDurabilitySwitches(env, (message) => warnings.push(message))
  return { switches, warnings }
}

describe('thread barrier durability switch', () => {
  it('is read from TASKWRAITH_THREAD_BARRIER_DURABILITY, beside the switches it excludes', () => {
    expect(THREAD_BARRIER_DURABILITY_ENV).toBe(BARRIER)
    expect([...FLUSHER_DURABILITY_ENVS]).toEqual(FLUSHERS)
    expect(CHECKPOINT_PUBLICATION_ENV).toBe(PUBLICATION)
    expect(THREAD_LOG_AUTHORITY_ENV).toBe(AUTHORITY)
  })

  it('is off, and says nothing, when the environment does not carry it', () => {
    expect(resolve({})).toEqual({
      switches: {
        barrierDurability: false,
        barrierDurabilityIgnored: null,
        logAuthority: false,
        logAuthorityIgnored: null,
        checkpointWorker: false
      },
      warnings: []
    })
    expect(isThreadBarrierDurabilityRequested({})).toBe(false)
  })

  it('is on for the exact token 1', () => {
    expect(isThreadBarrierDurabilityRequested({ [BARRIER]: '1' })).toBe(true)
    expect(resolve({ [BARRIER]: '1' })).toEqual({
      switches: {
        barrierDurability: true,
        barrierDurabilityIgnored: null,
        logAuthority: false,
        logAuthorityIgnored: null,
        checkpointWorker: false
      },
      warnings: []
    })
  })

  it.each(['', '0', 'true', 'TRUE', 'on', 'yes', ' 1', '1 ', '01', '1.0', '2', '11'])(
    'stays off, and says nothing, for %j',
    (value) => {
      expect(isThreadBarrierDurabilityRequested({ [BARRIER]: value })).toBe(false)
      const { switches, warnings } = resolve({ [BARRIER]: value })
      expect(switches.barrierDurability).toBe(false)
      expect(switches.barrierDurabilityIgnored).toBeNull()
      expect(warnings).toEqual([])
    }
  )

  it.each(FLUSHERS)('is ignored, with one warning, while %s is on', (flusher) => {
    const { switches, warnings } = resolve({ [BARRIER]: '1', [flusher]: '1' })

    expect(switches.barrierDurability).toBe(false)
    expect(switches.barrierDurabilityIgnored).toBe(`${flusher} on`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(BARRIER)
    expect(warnings[0]).toContain(flusher)
  })

  it('is ignored, with one warning, while checkpoint publication is on', () => {
    const { switches, warnings } = resolve({ [BARRIER]: '1', [PUBLICATION]: '1' })

    expect(switches.barrierDurability).toBe(false)
    expect(switches.barrierDurabilityIgnored).toBe(`${PUBLICATION} on`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(BARRIER)
    expect(warnings[0]).toContain(PUBLICATION)
  })

  it('reads checkpoint publication as on only by its own token, 1', () => {
    for (const value of ['', '0', 'true', ' 1']) {
      const { switches, warnings } = resolve({ [BARRIER]: '1', [PUBLICATION]: value })
      expect(switches.barrierDurability).toBe(true)
      expect(warnings).toEqual([])
    }
  })

  it('names every flusher switch that is on in its one warning', () => {
    const { switches, warnings } = resolve({
      [BARRIER]: '1',
      ...Object.fromEntries(FLUSHERS.map((name) => [name, '1']))
    })

    expect(switches.barrierDurability).toBe(false)
    expect(switches.barrierDurabilityIgnored).toBe(`${FLUSHERS.join(', ')} on`)
    expect(warnings).toHaveLength(1)
    for (const flusher of FLUSHERS) expect(warnings[0]).toContain(flusher)
  })

  it('reads a flusher switch as on only by its own token, 1', () => {
    const { switches, warnings } = resolve({
      [BARRIER]: '1',
      ...Object.fromEntries(FLUSHERS.map((name) => [name, 'true']))
    })

    expect(switches.barrierDurability).toBe(true)
    expect(warnings).toEqual([])
  })

  it('leaves the flusher switches as they are when it is off', () => {
    const { switches, warnings } = resolve(Object.fromEntries(FLUSHERS.map((name) => [name, '1'])))

    expect(switches.barrierDurability).toBe(false)
    expect(switches.barrierDurabilityIgnored).toBeNull()
    expect(warnings).toEqual([])
  })

  it('reads the process environment and warns on the console when given neither', () => {
    vi.stubEnv(BARRIER, '1')
    vi.stubEnv('TASKWRAITH_JOURNAL_FLUSHER', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveThreadDurabilitySwitches().barrierDurability).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the checkpoint worker the earlier mechanisms share, as the app honours it', () => {
  it('is built as TASKWRAITH_CHECKPOINT_WORKER asks while barrier durability is off', () => {
    expect(resolve({ [WORKER]: '1' })).toEqual({
      switches: expect.objectContaining({ barrierDurability: false, checkpointWorker: true }),
      warnings: []
    })
    for (const value of [undefined, '', '0', 'true', ' 1']) {
      expect(resolve({ [WORKER]: value }).switches.checkpointWorker).toBe(false)
    }
  })

  it('is never built while barrier durability is honoured, which has a pool of its own: the switch no longer matters', () => {
    for (const value of [undefined, '1', '0']) {
      const { switches, warnings } = resolve({ [BARRIER]: '1', [WORKER]: value })
      expect(switches).toMatchObject({ barrierDurability: true, checkpointWorker: false })
      expect(warnings).toEqual([])
    }
  })

  it('is built as asked again when barrier durability is ignored', () => {
    const { switches } = resolve({ [BARRIER]: '1', [PUBLICATION]: '1', [WORKER]: '1' })

    expect(switches).toMatchObject({ barrierDurability: false, checkpointWorker: true })
  })
})

describe('thread log authority, as the app honours it', () => {
  it('is on with barrier durability beside it', () => {
    expect(resolve({ [BARRIER]: '1', [AUTHORITY]: '1' })).toEqual({
      switches: {
        barrierDurability: true,
        barrierDurabilityIgnored: null,
        logAuthority: true,
        logAuthorityIgnored: null,
        checkpointWorker: false
      },
      warnings: []
    })
  })

  it('is ignored, with one warning, without barrier durability', () => {
    const { switches, warnings } = resolve({ [AUTHORITY]: '1' })

    expect(switches.logAuthority).toBe(false)
    expect(switches.logAuthorityIgnored).toBe(`${BARRIER} off`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(AUTHORITY)
    expect(warnings[0]).toContain(BARRIER)
  })

  it('is ignored when barrier durability was itself ignored, with one warning for each', () => {
    const { switches, warnings } = resolve({
      [AUTHORITY]: '1',
      [BARRIER]: '1',
      TASKWRAITH_RUN_EVENT_FLUSHER: '1'
    })

    expect(switches.barrierDurability).toBe(false)
    expect(switches.logAuthority).toBe(false)
    expect(switches.logAuthorityIgnored).toBe(`${BARRIER} ignored`)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain(AUTHORITY)
  })

  it('takes its on and off from the shared reader', () => {
    for (const value of ['', '0', 'true', ' 1']) {
      const { switches, warnings } = resolve({ [BARRIER]: '1', [AUTHORITY]: value })
      expect(switches.logAuthority).toBe(false)
      expect(switches.logAuthorityIgnored).toBeNull()
      expect(warnings).toEqual([])
    }
  })
})
