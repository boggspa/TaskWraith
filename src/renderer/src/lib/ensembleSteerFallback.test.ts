import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A steer must land. The ensemble composer steer path has no DOM test
 * environment here, so this pins its wiring in App.tsx the same way
 * composerSteerButton.test.ts does.
 *
 * Whitespace is squashed on both sides deliberately: indentation is not the
 * guarded property, and byte-exact source pins in this tree have already been
 * reddened by reformatting alone (see 63f4f200c, and
 * TranscriptPanel.userRowOrigin.test.ts).
 */
describe('a refused ensemble steer is re-dispatched rather than dropped', () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const squash = (text: string): string => text.replace(/\s+/g, '')
  const squashed = squash(source)

  it('builds the round payload once so both lanes send the same request', () => {
    expect(squashed).toContain(squash('const ensembleRoundPayload = {'))
    expect(squashed).toContain(
      squash("await window.api.runEnsembleRound({ ...ensembleRoundPayload, mode: 'steer' })")
    )
  })

  // isAcceptedEnsembleSteerResult admits exactly the statuses that prove main
  // retained the request, so a refusal proves it did NOT -- which is what makes
  // re-dispatching safe from double delivery.
  it('re-sends the same payload as an ordinary round when the steer is refused', () => {
    // Ordering rather than one contiguous match: the branch carries an
    // explanatory comment between the guard and the re-dispatch, and squashing
    // whitespace does not remove comment text.
    const guard = squashed.indexOf(squash('if (!isAcceptedEnsembleSteerResult(result)) {'))
    const fallback = squashed.indexOf(
      squash(
        "result = await window.api.runEnsembleRound({ ...ensembleRoundPayload, mode: 'normal' })"
      )
    )
    expect(guard).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(guard)
  })

  it('keeps the result rebindable so the fallback outcome is the one checked', () => {
    expect(squashed).toContain(squash('let result = await window.api.runEnsembleRound('))
    expect(squashed).not.toContain(
      squash('const result = await window.api.runEnsembleRound({ ...ensembleRoundPayload, mode:')
    )
  })

  // The draft is only restored once BOTH lanes have refused. Restoring after the
  // steer alone would put the text back while the ordinary round was still
  // about to carry it.
  it('restores the draft only after the fallback has also been refused', () => {
    const fallback = squashed.indexOf(
      squash("runEnsembleRound({ ...ensembleRoundPayload, mode: 'normal' })")
    )
    const restore = squashed.indexOf(squash('draftSubmission?.restoreIfUntouched()'))
    expect(fallback).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(fallback)
  })
})
