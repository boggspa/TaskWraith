import { describe, expect, it } from 'vitest'
import {
  WorkKeepAwakeAssertion,
  startWorkKeepAwakeMonitor,
  type PowerSaveBlockerApi
} from './WorkKeepAwakeAssertion'

/**
 * A faithful stand-in for Electron's `powerSaveBlocker`: ids are handed out
 * monotonically and `isStarted` answers from real state, so a test that stops
 * the wrong id or leaks one is visible rather than implied. `invalidate`
 * reproduces the case the renewal exists for — the OS dropping an assertion
 * underneath us without any call from this process.
 */
function makeFakePower(): PowerSaveBlockerApi & {
  started: number[]
  stopped: number[]
  invalidate(id: number): void
  liveCount(): number
} {
  const live = new Set<number>()
  const started: number[] = []
  const stopped: number[] = []
  let nextId = 1
  return {
    start(kind) {
      expect(kind).toBe('prevent-app-suspension')
      const id = nextId++
      live.add(id)
      started.push(id)
      return id
    },
    stop(id) {
      stopped.push(id)
      live.delete(id)
    },
    isStarted(id) {
      return live.has(id)
    },
    started,
    stopped,
    invalidate(id) {
      live.delete(id)
    },
    liveCount() {
      return live.size
    }
  }
}

function makeAssertion(): {
  assertion: WorkKeepAwakeAssertion
  power: ReturnType<typeof makeFakePower>
} {
  const power = makeFakePower()
  return { assertion: new WorkKeepAwakeAssertion({ powerSaveBlocker: power }), power }
}

describe('WorkKeepAwakeAssertion', () => {
  it('holds nothing while the setting is off, however much work is running', () => {
    const { assertion, power } = makeAssertion()
    assertion.setActiveWorkCount(5)
    expect(assertion.isHeld()).toBe(false)
    expect(power.started).toEqual([])
  })

  it('holds nothing while the setting is on but no work is running', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    expect(assertion.isHeld()).toBe(false)
    expect(power.started).toEqual([])
  })

  it('holds exactly one assertion once both the setting and work are present', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    expect(assertion.isHeld()).toBe(true)
    expect(power.started).toHaveLength(1)
  })

  it('holds regardless of which input arrives last', () => {
    const { assertion, power } = makeAssertion()
    assertion.setActiveWorkCount(2)
    assertion.setEnabled(true)
    expect(assertion.isHeld()).toBe(true)
    expect(power.started).toHaveLength(1)
  })

  it('does not start a second blocker while more work arrives', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    assertion.setActiveWorkCount(2)
    assertion.setActiveWorkCount(7)
    expect(power.started).toHaveLength(1)
    expect(power.liveCount()).toBe(1)
  })

  it('releases when the last work settles', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(2)
    const heldId = power.started[0]
    assertion.setActiveWorkCount(0)
    expect(assertion.isHeld()).toBe(false)
    expect(power.stopped).toEqual([heldId])
    expect(power.liveCount()).toBe(0)
  })

  it('releases immediately when the user turns the setting off mid-round', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(3)
    expect(assertion.isHeld()).toBe(true)
    assertion.setEnabled(false)
    expect(assertion.isHeld()).toBe(false)
    expect(power.liveCount()).toBe(0)
  })

  it('re-holds when the user turns the setting back on while work is still running', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(3)
    assertion.setEnabled(false)
    assertion.setEnabled(true)
    expect(assertion.isHeld()).toBe(true)
    expect(power.started).toHaveLength(2)
    expect(power.liveCount()).toBe(1)
  })

  it('repairs an assertion the OS invalidated underneath it, on renew', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    const firstId = power.started[0]
    power.invalidate(firstId)
    expect(assertion.isHeld()).toBe(false)

    assertion.renew('system resumed')

    expect(assertion.isHeld()).toBe(true)
    expect(power.started).toHaveLength(2)
    // The dead id must not be stopped again — that is the crash the guard exists
    // for. Asserted as an exact empty list: a `not.toContain` here would pass
    // vacuously the moment nothing was stopped at all.
    expect(power.stopped).toEqual([])
  })

  it('does not create an assertion on renew when it should not be holding one', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.renew('screen locked')
    expect(assertion.isHeld()).toBe(false)
    expect(power.started).toEqual([])
  })

  it('releases unconditionally on shutdown and is safe to call twice', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    assertion.release()
    assertion.release()
    expect(assertion.isHeld()).toBe(false)
    expect(power.stopped).toHaveLength(1)
    expect(power.liveCount()).toBe(0)
  })

  it('never stops an id it does not own', () => {
    const power = makeFakePower()
    const foreignId = power.start('prevent-app-suspension')
    const assertion = new WorkKeepAwakeAssertion({ powerSaveBlocker: power })
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    assertion.setActiveWorkCount(0)
    assertion.release()
    expect(power.stopped).not.toContain(foreignId)
    expect(power.isStarted(foreignId)).toBe(true)
  })

  it('treats a negative or non-finite work count as no work', () => {
    const { assertion, power } = makeAssertion()
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(Number.NaN)
    expect(assertion.isHeld()).toBe(false)
    assertion.setActiveWorkCount(-4)
    expect(assertion.isHeld()).toBe(false)
    expect(power.started).toEqual([])
  })

  it('reports each transition once, so the log cannot imply flapping', () => {
    const lines: string[] = []
    const power = makeFakePower()
    const assertion = new WorkKeepAwakeAssertion({
      powerSaveBlocker: power,
      log: (message) => lines.push(message)
    })
    assertion.setEnabled(true)
    assertion.setActiveWorkCount(1)
    assertion.setActiveWorkCount(2)
    assertion.setActiveWorkCount(0)
    expect(lines).toEqual([
      '[keep-awake] work power assertion held (work started)',
      '[keep-awake] work power assertion released (work settled)'
    ])
  })
})

describe('startWorkKeepAwakeMonitor', () => {
  function makeHarness(): {
    power: ReturnType<typeof makeFakePower>
    assertion: WorkKeepAwakeAssertion
    tick: () => void
    cleared: number
    stop: (() => void) | null
    state: { working: boolean; enabled: boolean }
  } {
    const power = makeFakePower()
    const assertion = new WorkKeepAwakeAssertion({ powerSaveBlocker: power })
    const state = { working: false, enabled: true }
    const harness = {
      power,
      assertion,
      tick: (): void => {},
      cleared: 0,
      stop: null as (() => void) | null,
      state
    }
    harness.stop = startWorkKeepAwakeMonitor(assertion, {
      hasActiveWork: () => state.working,
      isEnabled: () => state.enabled,
      setInterval: (handler) => {
        harness.tick = handler
        return 7 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {
        harness.cleared += 1
      }
    })
    return harness
  }

  it('evaluates once immediately rather than waiting a whole interval', () => {
    const power = makeFakePower()
    const assertion = new WorkKeepAwakeAssertion({ powerSaveBlocker: power })
    startWorkKeepAwakeMonitor(assertion, {
      hasActiveWork: () => true,
      isEnabled: () => true,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {}
    })
    expect(assertion.isHeld()).toBe(true)
  })

  it('holds when work starts and releases when it settles', () => {
    const h = makeHarness()
    expect(h.assertion.isHeld()).toBe(false)
    h.state.working = true
    h.tick()
    expect(h.assertion.isHeld()).toBe(true)
    h.state.working = false
    h.tick()
    expect(h.assertion.isHeld()).toBe(false)
  })

  it('picks up a settings change on the next tick, with no settings event', () => {
    const h = makeHarness()
    h.state.working = true
    h.tick()
    expect(h.assertion.isHeld()).toBe(true)
    h.state.enabled = false
    h.tick()
    expect(h.assertion.isHeld()).toBe(false)
    h.state.enabled = true
    h.tick()
    expect(h.assertion.isHeld()).toBe(true)
  })

  it('retains the assertion when the work read throws, rather than suspending unseen work', () => {
    const power = makeFakePower()
    const assertion = new WorkKeepAwakeAssertion({ powerSaveBlocker: power })
    let explode = false
    let tick = (): void => {}
    startWorkKeepAwakeMonitor(assertion, {
      hasActiveWork: () => {
        if (explode) throw new Error('run state unavailable')
        return false
      },
      isEnabled: () => true,
      setInterval: (handler) => {
        tick = handler
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {}
    })
    expect(assertion.isHeld()).toBe(false)
    explode = true
    tick()
    expect(assertion.isHeld()).toBe(true)
  })

  it('keeps the previous opt-in when the settings read throws', () => {
    const power = makeFakePower()
    const assertion = new WorkKeepAwakeAssertion({ powerSaveBlocker: power })
    let enabled = false
    let explode = false
    let tick = (): void => {}
    startWorkKeepAwakeMonitor(assertion, {
      hasActiveWork: () => true,
      isEnabled: () => {
        if (explode) throw new Error('settings unreadable')
        return enabled
      },
      setInterval: (handler) => {
        tick = handler
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {}
    })
    // Opted out, and a broken read must not silently switch it on.
    expect(assertion.isHeld()).toBe(false)
    explode = true
    tick()
    expect(assertion.isHeld()).toBe(false)

    // Opted in, and a broken read must not silently switch it off either.
    explode = false
    enabled = true
    tick()
    expect(assertion.isHeld()).toBe(true)
    explode = true
    tick()
    expect(assertion.isHeld()).toBe(true)
  })

  it('stops its timer when stopped', () => {
    const h = makeHarness()
    h.stop?.()
    expect(h.cleared).toBe(1)
  })
})
