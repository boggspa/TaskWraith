import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'

const indexUrl = new URL('../index.ts', import.meta.url)
// One claim below still has to read index.ts as text: the probe has no import
// locator. Everything else is anchored on declared names, call structure or a
// resolved `if` branch, so a rename or a reformat throws here instead of
// quietly passing over nothing.
const source = readFileSync(indexUrl, 'utf8')
const probe = new MainSourceProbe('src/main/index.ts', indexUrl)

describe('emulator Canvas composition wiring', () => {
  it('keeps runtime construction in the extracted factory and index to one branch', () => {
    // LEFT AS TEXT: MainSourceProbe has no import locator, so the module the
    // factory is imported from can only be pinned as a source substring.
    expect(source).toContain("from './emulator/EmulatorDriverFactory'")

    // index must build its driver by calling the EXTRACTED factory with a config
    // object. Was `toContain('createEmulatorCanvasDriverFactory({')`, which red
    // on any reformat of the call and could not tell a call from a mention.
    // Anchoring on the binding also pins WHERE the factory is invoked: a factory
    // call that drifts out of `createEmulatorCanvasDriver` no longer counts.
    const factoryCalls = probe.callsTo(
      probe.binding('createEmulatorCanvasDriver'),
      'createEmulatorCanvasDriverFactory'
    )
    expect(factoryCalls).toHaveLength(1)
    expect(probe.argText(factoryCalls[0], 0)).toMatch(/^\{/)

    // The containment claim: the driver call sits INSIDE the `kind === 'emulator'`
    // branch. Was a proximity regex,
    // /if \(kind === 'emulator'\)[\s\S]{0,500}?createEmulatorCanvasDriver\(\{/,
    // false-red-prone (one guard line added inside the branch, or prettier
    // breaking the argument onto its own line, pushes the call past the window)
    // and loose the other way (the span can run clean out of the branch, so a
    // second `kind === 'emulator'` check plus any nearby call satisfied it).
    // `guard` scopes to the real then-block and THROWS if the condition is
    // reworded, so neither direction survives.
    const emulatorBranch = probe.guard(probe.source, "kind === 'emulator'")
    expect(probe.callsTo(emulatorBranch, 'createEmulatorCanvasDriver')).toHaveLength(1)

    // ...and the title's other half — "index to one branch" — which nothing
    // pinned: exactly one call in the whole file, so no second branch can be
    // building a driver unnoticed.
    expect(probe.callsTo(probe.source, 'createEmulatorCanvasDriver')).toHaveLength(1)

    // The regression these two guard: emulator runtime construction creeping back
    // into the composition root instead of staying behind the extracted factory.
    // The throwing locator makes the absence claim self-proving — it reports
    // "never constructs <name>", so it cannot silently answer "nothing found",
    // and it also catches shapes the substring missed (`new X<T>(`).
    expect(() => probe.construction('CanvasEmulatorDriver')).toThrow(
      /never constructs `CanvasEmulatorDriver`/
    )
    expect(() => probe.construction('ElectronEmulatorRuntimeBridge')).toThrow(
      /never constructs `ElectronEmulatorRuntimeBridge`/
    )
  })
})
