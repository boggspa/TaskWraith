import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import {
  GROK_USAGE_BINARY_OVERRIDE_ENV,
  resolveGrokUsageProbeBinary
} from './GrokUsageBinaryOverride'

const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))

describe('resolveGrokUsageProbeBinary', () => {
  it('uses an explicit disposable binary without consulting host discovery', async () => {
    const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

    await expect(
      resolveGrokUsageProbeBinary({
        env: {
          [GROK_USAGE_BINARY_OVERRIDE_ENV]: '/acceptance/home/.grok/bin/grok'
        },
        resolveDefault
      })
    ).resolves.toEqual({
      binaryPath: '/acceptance/home/.grok/bin/grok',
      source: 'override'
    })
    expect(resolveDefault).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'relative/.grok/bin/grok'])(
    'fails closed for a present but invalid override %j',
    async (overridePath) => {
      const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

      await expect(
        resolveGrokUsageProbeBinary({
          env: { [GROK_USAGE_BINARY_OVERRIDE_ENV]: overridePath },
          resolveDefault
        })
      ).resolves.toEqual({
        binaryPath: null,
        source: 'invalid_override'
      })
      expect(resolveDefault).not.toHaveBeenCalled()
    }
  )

  it('uses ordinary provider discovery when no override is present', async () => {
    const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

    await expect(resolveGrokUsageProbeBinary({ env: {}, resolveDefault })).resolves.toEqual({
      binaryPath: '/owner/home/.grok/bin/grok',
      source: 'discovered'
    })
    expect(resolveDefault).toHaveBeenCalledOnce()
  })

  it('is wired into the production Grok usage handler', () => {
    // `src/main/index.ts` cannot be imported (it reaches into Electron at
    // load), so this claim is proven structurally rather than by slicing the
    // source between two literals. The slice this replaces ran from the
    // `ipcMain.handle('grok-usage:probe'` literal to `const watchPrPoller`,
    // i.e. past the end of the handler itself — anything registered in
    // between could satisfy its `toContain` checks, and the whole scan went
    // green-but-empty on any reformatting of the anchor line. Anchoring on
    // the registered channel and on the callback node keeps the claim scoped
    // to this handler and makes a rename throw instead of pass.
    const registrations = probe
      .callsTo(probe.source, 'handle')
      .filter(
        (call) =>
          probe.text(call.expression) === 'ipcMain.handle' &&
          call.arguments.length > 0 &&
          probe.argText(call, 0) === "'grok-usage:probe'"
      )
    expect(registrations).toHaveLength(1)

    const handler = registrations[0].arguments[1]
    const resolveBinary = probe.callsTo(handler, 'resolveGrokUsageProbeBinary')
    expect(resolveBinary).toHaveLength(1)
    // Production reads the override out of the real process environment —
    // a hard-coded or filtered env would strip the acceptance override that
    // the unit cases above prove this resolver honours.
    expect(probe.propText(resolveBinary[0], 0, 'env')).toBe('process.env')
    // ...and ordinary discovery stays the CLI provider lookup for 'grok', so
    // the no-override path still finds the owner's own installed binary.
    expect(probe.propText(resolveBinary[0], 0, 'resolveDefault')).toBe(
      "() => resolveCliProviderBinary('grok')"
    )
  })

  // Left as a text assertion deliberately: MainSourceProbe exposes no
  // source-order relation between two declarations, so "the grok-usage
  // handler is registered ahead of the watch-PR poller" — the bound that kept
  // the original slice from running to end-of-file — has no structural
  // counterpart. Migrating it would mean dropping the ordering, which is a
  // loosening, so it stays as it was.
  it('registers the handler ahead of the watch-PR poller construction', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const handlerStart = source.indexOf("ipcMain.handle('grok-usage:probe'")
    const pollerStart = source.indexOf('const watchPrPoller', handlerStart)

    expect(handlerStart).toBeGreaterThan(-1)
    expect(pollerStart).toBeGreaterThan(handlerStart)
  })
})
