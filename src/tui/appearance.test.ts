import { describe, expect, it, vi } from 'vitest'
import {
  OSC11_QUERY,
  appearanceFromColorFgBg,
  appearanceFromEnv,
  appearanceFromOsc11Reply,
  appearanceFromSystem,
  isInsideMultiplexer,
  probeTerminalAppearance,
  resolveTuiAppearance,
  type TuiAppearanceProbeIo
} from './appearance'

function probeIo(overrides: Partial<TuiAppearanceProbeIo> = {}): TuiAppearanceProbeIo & {
  rawModeCalls: boolean[]
  written: string[]
} {
  const rawModeCalls: boolean[] = []
  const written: string[] = []
  return {
    rawModeCalls,
    written,
    isTty: true,
    hasPendingInput: () => false,
    setRawMode: (raw) => rawModeCalls.push(raw),
    write: (data) => written.push(data),
    read: async () => '',
    ...overrides
  }
}

const noCommands = () => undefined

describe('TaskWraith TUI appearance detection', () => {
  it('reads the background field of COLORFGBG in either form', () => {
    expect(appearanceFromColorFgBg('15;0')).toBe('dark')
    expect(appearanceFromColorFgBg('0;15')).toBe('light')
    // Three-field form: some terminals put the cursor colour in the middle, so
    // the background is the LAST field, never the second.
    expect(appearanceFromColorFgBg('15;default;0')).toBe('dark')
    expect(appearanceFromColorFgBg('0;default;7')).toBe('light')
  })

  it('declines to guess from a COLORFGBG it cannot read', () => {
    expect(appearanceFromColorFgBg(undefined)).toBeUndefined()
    expect(appearanceFromColorFgBg('')).toBeUndefined()
    expect(appearanceFromColorFgBg('15;default')).toBeUndefined()
    expect(appearanceFromColorFgBg('15;260')).toBeUndefined()
  })

  it('prefers a declared appearance over an inferred one', () => {
    expect(appearanceFromEnv({ TASKWRAITH_APPEARANCE: 'light', COLORFGBG: '15;0' })).toBe('light')
    // The LC_ form is the one that survives SSH: OpenSSH forwards LC_* by
    // default and drops a bare name at the hop.
    expect(appearanceFromEnv({ LC_TASKWRAITH_APPEARANCE: 'Dark', COLORFGBG: '0;15' })).toBe('dark')
    expect(appearanceFromEnv({ TASKWRAITH_APPEARANCE: 'nonsense', COLORFGBG: '0;15' })).toBe(
      'light'
    )
    expect(appearanceFromEnv({})).toBeUndefined()
  })

  it('classifies an OSC 11 reply at any component width', () => {
    expect(appearanceFromOsc11Reply(']11;rgb:0000/0000/0000')).toBe('dark')
    expect(appearanceFromOsc11Reply(']11;rgb:ffff/ffff/ffff')).toBe('light')
    // Components are variable width and must each be scaled by their own
    // maximum: 'f' is full brightness in one digit, not 15/65535 of it.
    expect(appearanceFromOsc11Reply(']11;rgb:f/f/f')).toBe('light')
    expect(appearanceFromOsc11Reply(']11;rgb:1a1a/1b1b/2626')).toBe('dark')
    expect(appearanceFromOsc11Reply('')).toBeUndefined()
    expect(appearanceFromOsc11Reply('garbage')).toBeUndefined()
  })

  it('never probes a multiplexer, which answers for itself', () => {
    for (const env of [{ TMUX: '/tmp/x' }, { STY: '1.pts' }, { ZELLIJ: '0' }]) {
      expect(isInsideMultiplexer(env)).toBe(true)
    }
    expect(isInsideMultiplexer({})).toBe(false)
  })

  it('skips the probe entirely when it must not take the tty', async () => {
    const notTty = probeIo({ isTty: false })
    expect(await probeTerminalAppearance(notTty, {})).toBeUndefined()
    expect(notTty.written).toEqual([])

    const multiplexed = probeIo()
    expect(await probeTerminalAppearance(multiplexed, { TMUX: '/tmp/x' })).toBeUndefined()
    expect(multiplexed.written).toEqual([])

    // Queued input is the user typing. Reading here eats their keystrokes, and
    // no measurement is worth a swallowed keypress.
    const busy = probeIo({ hasPendingInput: () => true })
    expect(await probeTerminalAppearance(busy, {})).toBeUndefined()
    expect(busy.written).toEqual([])
    expect(busy.rawModeCalls).toEqual([])
  })

  it('asks the terminal and restores cooked mode afterwards', async () => {
    const io = probeIo({ read: async () => `]11;rgb:1a1a/1b1b/2626` })
    expect(await probeTerminalAppearance(io, {})).toBe('dark')
    expect(io.written).toEqual([OSC11_QUERY])
    expect(io.rawModeCalls).toEqual([true, false])
  })

  it('restores cooked mode even when the read throws', async () => {
    // A probe that leaves the tty raw makes the terminal unusable, so the
    // restore has to survive the failure path, not just the happy one.
    const io = probeIo({
      read: async () => {
        throw new Error('tty went away')
      }
    })
    expect(await probeTerminalAppearance(io, {})).toBeUndefined()
    expect(io.rawModeCalls).toEqual([true, false])
  })

  it('treats a terminal that never answers as no answer', async () => {
    const io = probeIo({ read: async () => '' })
    expect(await probeTerminalAppearance(io, {})).toBeUndefined()
    expect(io.rawModeCalls).toEqual([true, false])
  })

  it('reads macOS appearance, where absent means light', () => {
    expect(appearanceFromSystem('darwin', () => 'Dark\n')).toBe('dark')
    // `defaults read` exits non-zero in light mode because the key is simply
    // not there — the failure IS the answer.
    expect(appearanceFromSystem('darwin', noCommands)).toBe('light')
    expect(appearanceFromSystem('linux', () => "'prefer-dark'\n")).toBe('dark')
    expect(appearanceFromSystem('linux', () => "'default'\n")).toBeUndefined()
    expect(appearanceFromSystem('win32', () => 'anything')).toBeUndefined()
  })

  it('walks the ladder in order and stops at the first real answer', async () => {
    const system = vi.fn(() => 'Dark\n')
    // Rung 1 wins outright: no probe, no system call.
    const io = probeIo({ read: async () => ']11;rgb:0000/0000/0000' })
    expect(
      await resolveTuiAppearance({
        env: { TASKWRAITH_APPEARANCE: 'light' },
        platform: 'darwin',
        run: system,
        probe: io
      })
    ).toBe('light')
    expect(io.written).toEqual([])
    expect(system).not.toHaveBeenCalled()

    // Rung 3 beats rung 4: the terminal outranks its surroundings.
    expect(
      await resolveTuiAppearance({
        env: {},
        platform: 'darwin',
        run: () => undefined,
        probe: probeIo({ read: async () => ']11;rgb:0000/0000/0000' })
      })
    ).toBe('dark')

    // Rung 4 only when the terminal declined to answer.
    expect(
      await resolveTuiAppearance({
        env: {},
        platform: 'darwin',
        run: () => undefined,
        probe: probeIo({ read: async () => '' })
      })
    ).toBe('light')
  })

  it('falls back to dark when nothing knows', async () => {
    // A wrong dark theme stays readable on a light terminal; a wrong light
    // theme on a dark one does not.
    expect(await resolveTuiAppearance({ env: {}, platform: 'freebsd', run: noCommands })).toBe(
      'dark'
    )
  })
})
