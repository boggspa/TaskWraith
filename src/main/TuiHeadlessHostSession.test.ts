import { describe, expect, it, vi } from 'vitest'

import {
  TUI_HEADLESS_HOST_ARG,
  TUI_HEADLESS_HOST_PARENT_ARG,
  TuiHeadlessHostSession,
  isTuiHeadlessHostLaunchRequest,
  resolveTuiHeadlessHostLaunchPosture
} from './TuiHeadlessHostSession'

function headlessArgs(parentPid = 42): string[] {
  return ['TaskWraith', TUI_HEADLESS_HOST_ARG, `${TUI_HEADLESS_HOST_PARENT_ARG}${parentPid}`]
}

describe('TuiHeadlessHostSession', () => {
  it('requires an exact positive parent identity for headless launches', () => {
    expect(resolveTuiHeadlessHostLaunchPosture(['TaskWraith'])).toEqual({ kind: 'desktop' })
    expect(resolveTuiHeadlessHostLaunchPosture(headlessArgs())).toEqual({
      kind: 'headless',
      parentPid: 42
    })
    expect(resolveTuiHeadlessHostLaunchPosture(['TaskWraith', TUI_HEADLESS_HOST_ARG])).toEqual({
      kind: 'invalid',
      error: 'Headless Host requires one parent process identity.'
    })
    expect(
      resolveTuiHeadlessHostLaunchPosture([
        'TaskWraith',
        TUI_HEADLESS_HOST_ARG,
        `${TUI_HEADLESS_HOST_PARENT_ARG}nope`
      ])
    ).toEqual({
      kind: 'invalid',
      error: 'Headless Host parent process identity is invalid.'
    })
  })

  it('recognizes duplicate headless requests without trusting their parent argument', () => {
    expect(isTuiHeadlessHostLaunchRequest([TUI_HEADLESS_HOST_ARG])).toBe(true)
    expect(isTuiHeadlessHostLaunchRequest(['--ordinary-launch'])).toBe(false)
  })

  it('suppresses macOS presentation until an ordinary launch promotes it', () => {
    const session = new TuiHeadlessHostSession({ argv: headlessArgs(), platform: 'darwin' })
    expect(session.isHeadless).toBe(true)
    expect(session.shouldSuppressMacPresentation).toBe(true)
    expect(session.shouldPresentForSecondInstance(headlessArgs(84))).toBe(false)
    expect(session.isHeadless).toBe(true)
    expect(session.shouldPresentForSecondInstance(['TaskWraith'])).toBe(true)
    expect(session.isHeadless).toBe(false)
    expect(session.shouldSuppressMacPresentation).toBe(false)
  })

  it('quits only after the parent grace, all clients leave, and active work ends', () => {
    let tick: (() => void) | undefined
    let now = 1_000
    let clients = 1
    let active = true
    const quit = vi.fn()
    const session = new TuiHeadlessHostSession({
      argv: headlessArgs(),
      now: () => now,
      isProcessAlive: () => false,
      orphanGraceMs: 3_000,
      setInterval: ((callback: () => void) => {
        tick = callback
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval
    })
    session.startMonitoring({
      getConnectedClientCount: () => clients,
      hasActiveWork: () => active,
      quit
    })

    expect(quit).not.toHaveBeenCalled()
    now = 5_000
    tick?.()
    expect(quit).not.toHaveBeenCalled()
    clients = 0
    tick?.()
    expect(quit).not.toHaveBeenCalled()
    active = false
    tick?.()
    expect(quit).toHaveBeenCalledTimes(1)
    tick?.()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('fails safe when client or run occupancy cannot be read', () => {
    let tick: (() => void) | undefined
    let now = 1_000
    const quit = vi.fn()
    const session = new TuiHeadlessHostSession({
      argv: headlessArgs(),
      now: () => now,
      isProcessAlive: () => false,
      orphanGraceMs: 0,
      setInterval: ((callback: () => void) => {
        tick = callback
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval
    })
    session.startMonitoring({
      getConnectedClientCount: () => {
        throw new Error('unavailable')
      },
      hasActiveWork: () => {
        throw new Error('unavailable')
      },
      quit
    })
    now += 1
    tick?.()
    expect(quit).not.toHaveBeenCalled()
  })
})
