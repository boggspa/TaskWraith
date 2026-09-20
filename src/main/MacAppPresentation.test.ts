import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { setMacAppPresentation } from './MacAppPresentation'
import { MainSourceProbe } from './mainSourceProbe.testutil'

function appTarget() {
  return {
    setActivationPolicy: vi.fn(),
    dock: { hide: vi.fn(), show: vi.fn(async () => undefined) }
  }
}

describe('macOS application presentation', () => {
  it('keeps a helper out of the Dock with one native transition', () => {
    const app = appTarget()
    setMacAppPresentation(app, false, 'darwin')
    expect(app.setActivationPolicy).toHaveBeenCalledExactlyOnceWith('accessory')
    expect(app.dock.hide).not.toHaveBeenCalled()
    expect(app.dock.show).not.toHaveBeenCalled()
  })

  it('promotes the primary desktop and a user-opened headless Host to a normal app', () => {
    const app = appTarget()
    setMacAppPresentation(app, false, 'darwin')
    setMacAppPresentation(app, true, 'darwin')
    expect(app.setActivationPolicy.mock.calls).toEqual([['accessory'], ['regular']])
    expect(app.dock.show).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'] as const)('does nothing on %s', (platform) => {
    const app = appTarget()
    setMacAppPresentation(app, false, platform)
    setMacAppPresentation(app, true, platform)
    expect(app.setActivationPolicy).not.toHaveBeenCalled()
    expect(app.dock.hide).not.toHaveBeenCalled()
    expect(app.dock.show).not.toHaveBeenCalled()
  })

  it('falls back to the Dock API only when the activation-policy API fails', () => {
    const app = appTarget()
    app.setActivationPolicy.mockImplementation(() => {
      throw new Error('policy unavailable')
    })
    setMacAppPresentation(app, false, 'darwin')
    setMacAppPresentation(app, true, 'darwin')
    expect(app.dock.hide).toHaveBeenCalledOnce()
    expect(app.dock.show).toHaveBeenCalledOnce()
  })

  it('does not interrupt helper work or reject startup when presentation fails', async () => {
    const app = appTarget()
    app.setActivationPolicy.mockImplementation(() => {
      throw new Error('policy unavailable')
    })
    app.dock.hide.mockImplementation(() => {
      throw new Error('Dock unavailable')
    })
    app.dock.show.mockRejectedValue(new Error('Dock unavailable'))
    expect(() => setMacAppPresentation(app, false, 'darwin')).not.toThrow()
    expect(() => setMacAppPresentation(app, true, 'darwin')).not.toThrow()
    await Promise.resolve()
  })
})

describe('macOS presentation startup wiring', () => {
  it('hides helpers before profile selection can refuse a static bridge launch', () => {
    const probe = new MainSourceProbe('devAppName.ts', new URL('./devAppName.ts', import.meta.url))
    const helperGuard = probe.guard(probe.source, 'shouldSuppressMacAppPresentation()')
    const calls = probe.callsTo(helperGuard, 'setMacAppPresentation')
    expect(calls).toHaveLength(1)
    expect(probe.argText(calls[0], 1)).toBe('false')
    expect(calls[0].getStart()).toBeLessThan(
      probe.binding('configuredEarlyInstancePosture').getStart()
    )
  })

  it('presents only the ordinary desktop in the primary-only preparation callback', () => {
    const probe = new MainSourceProbe('bootstrap.ts', new URL('./bootstrap.ts', import.meta.url))
    const calls = probe.callsTo(probe.source, 'bootstrapMainProcess')
    expect(calls).toHaveLength(1)
    const options = calls[0].arguments[0]
    if (!ts.isObjectLiteralExpression(options)) throw new Error('Missing bootstrap options')
    const prepare = options.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) && property.name.getText() === 'prepareMainProcess'
    )
    if (!prepare || !ts.isPropertyAssignment(prepare)) throw new Error('Missing preparation')
    const desktopGuard = probe.guard(prepare.initializer, '!shouldSuppressMacAppPresentation()')
    const presentationCalls = probe.callsTo(probe.source, 'setMacAppPresentation')
    expect(presentationCalls).toHaveLength(1)
    expect(probe.callsTo(desktopGuard, 'setMacAppPresentation')).toEqual(presentationCalls)
    expect(probe.argText(presentationCalls[0], 1)).toBe('true')
  })
})
