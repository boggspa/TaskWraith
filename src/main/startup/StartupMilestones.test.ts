import { describe, expect, it, vi } from 'vitest'

import { StartupMilestoneRecorder, STARTUP_MILESTONES_ENV } from './StartupMilestones'

function recorder(enabled: boolean) {
  let now = 0
  const lines: string[] = []
  const rec = new StartupMilestoneRecorder({
    enabled,
    now: () => now,
    log: (line) => lines.push(line)
  })
  return { rec, lines, advance: (ms: number) => (now += ms) }
}

describe('StartupMilestoneRecorder', () => {
  it('records nothing at all when disabled', () => {
    const { rec, lines, advance } = recorder(false)
    rec.mark('a')
    advance(100)
    rec.mark('b')
    rec.report()
    expect(rec.milestones()).toEqual([])
    expect(lines).toEqual([])
  })

  it('records absolute and per-step times', () => {
    const { rec, advance } = recorder(true)
    advance(300)
    rec.mark('main-graph-imported')
    advance(1200)
    rec.mark('workspace-lock-open')
    advance(200)
    rec.mark('create-window')
    expect(rec.milestones()).toEqual([
      { name: 'main-graph-imported', atMs: 300, deltaMs: 300 },
      { name: 'workspace-lock-open', atMs: 1500, deltaMs: 1200 },
      { name: 'create-window', atMs: 1700, deltaMs: 200 }
    ])
  })

  it('prints one line, once, so a re-shown window cannot spam it', () => {
    const { rec, lines, advance } = recorder(true)
    rec.mark('a')
    advance(50)
    rec.mark('b')
    rec.report()
    rec.report()
    expect(lines).toEqual(['[startup] a=0ms(+0) b=50ms(+50)'])
  })

  it('prints nothing when there is nothing to print', () => {
    const { rec, lines } = recorder(true)
    rec.report()
    expect(lines).toEqual([])
  })

  it('is off by default unless the env var is exactly 1', () => {
    const previous = process.env[STARTUP_MILESTONES_ENV]
    try {
      for (const [value, expected] of [
        [undefined, 0],
        ['0', 0],
        ['true', 0],
        ['1', 1]
      ] as const) {
        if (value === undefined) delete process.env[STARTUP_MILESTONES_ENV]
        else process.env[STARTUP_MILESTONES_ENV] = value
        const log = vi.fn()
        const rec = new StartupMilestoneRecorder({ now: () => 1, log })
        rec.mark('x')
        expect(rec.milestones().length).toBe(expected)
      }
    } finally {
      if (previous === undefined) delete process.env[STARTUP_MILESTONES_ENV]
      else process.env[STARTUP_MILESTONES_ENV] = previous
    }
  })
})
