import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Guards the run-dispatch path in `executeRun` against the projection class:
 * a ChatRecord that arrives WITHOUT `messages`/`runs`.
 *
 * Both fields are declared REQUIRED on ChatRecord, so tsc cannot flag a read
 * of them -- yet catalogue and summary projections ship without them, and
 * `refreshSingleChat` hydration is best-effort (it returns null when `getChat`
 * yields nothing, which is exactly a brand-new thread). The observed failure
 * was `TypeError: Cannot read properties of undefined (reading 'length')`
 * surfacing as "Run execution failed unexpectedly" in the transcript.
 *
 * What made it more than a cosmetic bubble: the throw landed AFTER
 * `setIsThinking(true)` and BEFORE the ChatRun was created, and the outer catch
 * unwound none of it. So the turn died with no run on the record at all, the
 * surface stayed on "Working", and `runSchedulerBusyRef` stayed pinned -- which
 * is the same 00:00:00:00-under-a-live-chip signature that
 * `activeRunSelection.test.ts` covers from the read side.
 *
 * There is no jsdom in this repo (~251 renderer suites are
 * `renderToStaticMarkup`), and `executeRun` is a ~1700-line closure inside App,
 * so this is pinned by source the way `approvalPresentationGate.test.ts` and
 * `multiviewPaneComposerParity.test.ts` pin theirs.
 */
const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf-8').replace(
  /\r\n/g,
  '\n'
)

/** The `executeRun` body, so every assertion below is scoped to it. */
function executeRunSource(): string {
  const start = app.indexOf('const executeRun = ')
  expect(start).toBeGreaterThan(-1)
  const end = app.indexOf('Run execution failed unexpectedly', start)
  expect(end).toBeGreaterThan(start)
  return app.slice(start, end)
}

describe('run dispatch survives a record with no transcript', () => {
  it('hydrates on a DROPPED transcript, not only on the summaryOnly flag', () => {
    const body = executeRunSource()
    expect(body).toContain('isChatSummaryRecord(runChat) ||')
    expect(body).toContain('!Array.isArray(runChat.messages) ||')
    expect(body).toContain('!Array.isArray(runChat.runs)')
  })

  it('normalises messages and runs at the single chatToUpdate construction point', () => {
    const body = executeRunSource()
    expect(body).toContain(
      'messages: Array.isArray(dispatchChatBase.messages) ? dispatchChatBase.messages : []'
    )
    expect(body).toContain(
      'runs: Array.isArray(dispatchChatBase.runs) ? dispatchChatBase.runs : []'
    )
  })

  it('normalises BEFORE the read that used to throw', () => {
    // `chatToUpdate.messages.length === 0` is the exact crash expression and it
    // is still there -- it is safe now only because the construction above
    // guarantees an array. Pin that ORDER, so moving the read above the
    // normalisation (or reintroducing a second unnormalised base) reds.
    const body = executeRunSource()
    const normalised = body.indexOf(
      'messages: Array.isArray(dispatchChatBase.messages) ? dispatchChatBase.messages : []'
    )
    const crashRead = body.indexOf('chatToUpdate.messages.length === 0')
    expect(normalised).toBeGreaterThan(-1)
    expect(crashRead).toBeGreaterThan(-1)
    expect(crashRead).toBeGreaterThan(normalised)
    // And no OTHER chatToUpdate base escapes the normalisation.
    expect(body.split('const chatToUpdate = ')).toHaveLength(2)
  })

  it('unwinds the thinking flag and the scheduler when dispatch never happened', () => {
    // `setIsThinking(true)` fires before the throw site; every clearing call in
    // executeRun lives inside the stream-adapter callback, which a pre-dispatch
    // abort never reaches. Without this the surface wedges on "Working".
    const catchStart = app.indexOf("console.warn('[executeRun] uncaught exception:', error)")
    expect(catchStart).toBeGreaterThan(-1)
    const unwind = app.slice(catchStart, catchStart + 1200)
    expect(unwind).toContain('if (!dispatchAccepted) {')
    expect(unwind).toContain('setIsThinking(false)')
    expect(unwind).toContain('syncRunningState()')
  })

  it('is anchored to a file that exists and is non-trivial', () => {
    expect(app.length).toBeGreaterThan(100_000)
  })
})
