import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * App.tsx has no DOM harness here, so these pin the wiring as source structure.
 * Whitespace is squashed on both sides: indentation is not the guarded
 * property, and byte-exact pins in this tree have already been reddened by
 * reformatting alone (63f4f200c, TranscriptPanel.userRowOrigin.test.ts).
 */
const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const squash = (text: string): string => text.replace(/\s+/g, '')

function slice(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('handleSteerToQueuedMessage releases its in-flight guard', () => {
  const handler = squash(
    slice('const handleSteerToQueuedMessage =', 'const handleReorderQueuedMessages =')
  )

  // queuedSteerInFlightRunIdsRef is what suppresses a re-entrant click. Every
  // explicit return cleared it, but a throw out of any await did not -- and a
  // leaked entry left that row's Steer permanently dead for the session.
  it('clears the run id in a finally, not only on the explicit returns', () => {
    expect(handler).toContain(squash('} finally { clearQueuedSteerInFlight() }'))
  })

  it('still clears eagerly on the known failure paths', () => {
    expect(handler.split(squash('clearQueuedSteerInFlight()')).length - 1).toBeGreaterThan(1)
  })
})

describe('handleSteerToQueuedMessage explains a click that cannot land', () => {
  const handler = squash(
    slice('const handleSteerToQueuedMessage =', 'const handleReorderQueuedMessages =')
  )

  it.each([
    ['the round rolled over', 'the round it was queued against has already finished'],
    ['the entry left the queue', 'it is no longer in the round queue'],
    ['the queued request is gone', 'its queued request is no longer tracked'],
    [
      'the row belongs to another chat',
      'it belongs to a different chat than the pane it was clicked in'
    ]
  ])('surfaces when %s', (_label, reason) => {
    expect(handler).toContain(squash(reason))
  })

  it('no longer returns bare from those branches', () => {
    expect(handler).not.toContain(squash('if (!prompt) return'))
    expect(handler).not.toContain(squash('if (!match) return'))
    expect(handler).not.toContain(
      squash('if (!chat || !round || round.roundId !== queuedRoundId) return')
    )
  })

  // A click while the previous dispatch is still in flight is NOT a failure --
  // the first click is still working and will report for itself. Those two
  // guards stay deliberately silent.
  it('stays silent for a re-entrant click', () => {
    expect(handler).toContain(squash('if (queuedSteerInFlightRunIdsRef.current.has(runId)) return'))
    expect(handler).toContain(
      squash('if (ensembleSteerInFlightChatIdsRef.current.has(ensembleChatId)) return')
    )
  })
})

describe('a slash-command round refusal is not treated as a send', () => {
  const handler = squash(
    slice('const runScopedEnsembleRoundFromSlash =', 'const pluginSlashTokenSegment =')
  )

  // Every refusal arrives as a FULFILLED promise, so the old `.then(() => {...})`
  // ran on ignored/busy/no-receipt too: draft cleared, attachments dropped and
  // the Thinking badge lit for a round that was never started.
  it('classifies the receipt instead of assuming the round started', () => {
    expect(handler).toContain(squash('ensembleRoundDispatchRefusal(settled)'))
    expect(handler).not.toContain(squash('.then(() => {'))
  })

  it('re-sends a refused steer as an ordinary round so it still lands', () => {
    expect(handler).toContain(squash("slashRoundMode === 'steer' && ensembleRoundDispatchRefusal("))
    expect(handler).toContain(squash("...slashRoundPayload, mode: 'normal'"))
  })

  it('reports the refusal and returns before any success side effect', () => {
    const refusal = handler.indexOf(squash('was not sent:'))
    const clearDraft = handler.indexOf(squash("setChatPromptDraft(chat.appChatId, '')"))
    const thinking = handler.indexOf(squash('setIsThinking(true)'))
    expect(refusal).toBeGreaterThan(-1)
    expect(clearDraft).toBeGreaterThan(refusal)
    expect(thinking).toBeGreaterThan(refusal)
  })
})
