import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'

/**
 * These claims are about wiring in modules the test cannot import (index.ts
 * reaches into Electron at load), so they are asserted structurally rather than
 * as source substrings.
 *
 * What this file used to do: `readFileSync` + `indexOf`-anchored `slice` +
 * `toContain('imagePaths: payload.imagePaths')`. That reds on a rename or a
 * reformat, and the compaction claim — the one negative here — went GREEN
 * whenever its anchor stopped resolving, because `indexOf` returning -1 made
 * `slice(-1)` a one-character window with nothing in it. Declared names and
 * call structure remove both failure modes: `fn` throws when its subject is
 * renamed, and `propText` reads the property regardless of order or wrapping.
 */
const probeFor = (relativePath: string): MainSourceProbe =>
  new MainSourceProbe(`src/main/${relativePath}`, new URL(`../${relativePath}`, import.meta.url))

const index = probeFor('index.ts')

describe('ACP image dispatch integration', () => {
  it.each([
    ['grok/GrokAcpClient.ts', 'runGrokAcpTurn'],
    ['kimi/KimiAcpClient.ts', 'runKimiAcpTurn'],
    // Mistral's exported entry point splits into an introduction turn and the
    // working turn; only the working turn carries a user prompt, so that is the
    // one that must forward images.
    ['mistral/MistralAcpClient.ts', 'runMistralWorkingTurn']
  ])('%s forwards the main-authorized image array into the neutral client', (file, adapter) => {
    const probe = probeFor(file)
    const neutral = probe.callsTo(probe.fn(adapter), 'runAcpTurn')

    expect(neutral).toHaveLength(1)
    // `prompt` pins that we are reading the real options object handed to the
    // neutral core; `imagePaths` is the claim: the caller's own array, passed
    // through rather than re-derived, filtered or dropped at the adapter seam.
    expect(probe.propText(neutral[0], 0, 'prompt')).toBe('options.prompt')
    expect(probe.propText(neutral[0], 0, 'imagePaths')).toBe('options.imagePaths')
  })

  it('wires normal provider launches while keeping Kimi maintenance compaction image-free', () => {
    const grokLaunch = index.callsTo(
      index.fn('runGrokAcpProviderAfterWorkspaceLockAdmission'),
      'runGrokAcpTurn'
    )
    const mistralLaunch = index.callsTo(index.fn('runMistralAcpProvider'), 'runMistralAcpTurn')
    const kimiLaunch = index.callsTo(index.fn('runKimiAcpProvider'), 'runKimiAcpTurn')
    const compactionLaunch = index.callsTo(
      index.fn('compactKimiProviderContext'),
      'runKimiAcpTurn'
    )

    // Exactly one launch site per lane. A second one is a lane that forked
    // without carrying the image wiring with it.
    expect(grokLaunch).toHaveLength(1)
    expect(mistralLaunch).toHaveLength(1)
    expect(kimiLaunch).toHaveLength(1)
    expect(compactionLaunch).toHaveLength(1)

    expect(index.propText(grokLaunch[0], 0, 'imagePaths')).toBe('payload.imagePaths')
    expect(index.propText(mistralLaunch[0], 0, 'imagePaths')).toBe('payload.imagePaths')
    expect(index.propText(kimiLaunch[0], 0, 'imagePaths')).toBe('payload.imagePaths')

    // Maintenance compaction is a host-initiated `/compact` turn against a
    // resumed session — it carries no user attachment, so no image array may
    // ride it. The `prompt` read is what makes this absence claim non-vacuous:
    // it proves the locator landed on the real options literal of the real
    // call, so `imagePaths` being absent is a fact about production and not
    // about a window that failed to resolve.
    expect(index.propText(compactionLaunch[0], 0, 'prompt')).toBe('production.session.prompt')
    expect(index.propText(compactionLaunch[0], 0, 'imagePaths')).toBeNull()
  })
})
