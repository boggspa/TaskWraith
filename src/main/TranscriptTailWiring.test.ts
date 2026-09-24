import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_TAIL_CHANNEL } from '../shared/transcriptTailStream'

/**
 * Source-text guard for a send-only IPC lane.
 *
 * `IpcValidation.test.ts` enumerates every `ipcMain.handle` channel and fails
 * when one has no argument schema — but it is invoke-direction only. NOTHING in
 * CI enumerates main→renderer `send`/`broadcast` channels and checks that the
 * preload actually listens for them. A one-way channel that main emits into a
 * preload that never registered it fails completely silently: no error, no
 * warning, no failing test. Main talks to nobody and the transcript quietly
 * goes back to being as slow as it was before this lane existed.
 *
 * These are deliberately narrow source-text assertions rather than a repo-wide
 * channel registry. A broad guard would red on day one against the send
 * channels that already have gaps, get suppressed, and protect nothing.
 */
const ROOT = join(__dirname, '..', '..')

/**
 * Comments are stripped before any assertion runs.
 *
 * Proven necessary: with raw source, moving the emit below the write and
 * leaving `// was: broadcastTranscriptTail(normalized)` behind kept the
 * ordering test green — `indexOf` found the comment. A guard that a comment can
 * satisfy guards nothing.
 */
function source(relativePath: string): string {
  // Line-based, deliberately. A regex block-comment strip over a 63k-line file
  // matches the `*/` inside a glob literal like '**/*' and eats everything up
  // to it — measured here, it silently deleted real code and turned this guard
  // into noise. Full-line comments are all the mutation needs anyway.
  return readFileSync(join(ROOT, relativePath), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

/**
 * A function's real body, brace-matched.
 *
 * A magic character count is a slow-motion false red: `saveAndBroadcastChat`
 * grew 552 characters in a single session, and a fixed 2,000-char window either
 * truncates the function (missing an anchor that is present) or spills into the
 * next one (asserting `not.toContain` against a neighbour's code).
 */
function functionBody(text: string, signature: string): string {
  const start = text.indexOf(signature)
  if (start < 0) return ''
  // Skip the parameter list before looking for the body brace: a default like
  // `options: ChatSaveOptions = {}` is the FIRST `{` after the signature, and
  // matching from it returns an empty body that silently passes every
  // `not.toContain` and fails every positive assertion for the wrong reason.
  let depth = 0
  let cursor = text.indexOf('(', start)
  if (cursor < 0) return ''
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const open = text.indexOf('{', cursor)
  if (open < 0) return ''
  depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  return ''
}

describe('transcript tail lane wiring', () => {
  const mainSource = source('src/main/index.ts')
  const preloadSource = source('src/preload/index.ts')
  const hookSource = source('src/renderer/src/hooks/useChatUpdateInterestRuntime.ts')

  it('names the channel through the shared constant on both sides of the wire', () => {
    expect(TRANSCRIPT_TAIL_CHANNEL).toBe('transcript-tail-appended')
    // A bare string literal on either side is how the two ends drift apart.
    expect(mainSource).toContain('TRANSCRIPT_TAIL_CHANNEL')
    expect(preloadSource).toContain('TRANSCRIPT_TAIL_CHANNEL')
    expect(mainSource).not.toContain(`'${TRANSCRIPT_TAIL_CHANNEL}'`)
    expect(preloadSource).not.toContain(`'${TRANSCRIPT_TAIL_CHANNEL}'`)
  })

  it('registers the preload listener AND its bulk teardown', () => {
    expect(preloadSource).toContain('ipcRenderer.on(TRANSCRIPT_TAIL_CHANNEL, wrapped)')
    expect(preloadSource).toContain('ipcRenderer.removeListener(TRANSCRIPT_TAIL_CHANNEL, wrapped)')
    // The second registry. Missing it leaks a listener across a reload, which
    // presents as rows landing twice rather than as an obvious failure.
    expect(preloadSource).toContain('ipcRenderer.removeAllListeners(TRANSCRIPT_TAIL_CHANNEL)')
  })

  it('has a renderer consumer, so main is not emitting into the void', () => {
    // Identifiers alone are satisfied by an import line. Assert the CALLS.
    expect(hookSource).toContain('this.bridge.onTranscriptTailAppended(')
    const handler = functionBody(hookSource, 'private handleTranscriptTailFrame(')
    expect(handler).not.toBe('')
    expect(handler).toContain('applyTranscriptTailFrame(')
    expect(handler).toContain('this.stallWatchdog.announce(')
  })

  it('emits BEFORE persistence in saveAndBroadcastChat', () => {
    const body = functionBody(mainSource, 'function saveAndBroadcastChat(')
    expect(body).not.toBe('')

    const emitAt = body.indexOf('broadcastTranscriptTail(normalized)')
    const saveAt = body.indexOf('AppStore.saveChat(normalized')
    const broadcastAt = body.indexOf('broadcastChatUpdated(saved)')
    expect(emitAt).toBeGreaterThan(-1)
    expect(saveAt).toBeGreaterThan(-1)
    expect(broadcastAt).toBeGreaterThan(-1)

    // The entire point of the lane. Moving the emit below the write would
    // silently restore the old latency while every test above still passed.
    expect(emitAt).toBeLessThan(saveAt)
    expect(emitAt).toBeLessThan(broadcastAt)
  })

  it('also emits from the universal broadcast fan-out, not just the save helper', () => {
    // ~35 producers persist and then broadcast directly. Hooking only
    // `saveAndBroadcastChat` leaves every one of them on the slow lane.
    const body = functionBody(mainSource, 'function broadcastChatUpdatedExcept(')
    expect(body).not.toBe('')
    expect(body).toContain('broadcastTranscriptTail(chat)')
  })

  it('feeds the append-to-visible histogram from the send path', () => {
    const body = functionBody(mainSource, 'function broadcastTranscriptTail(')
    expect(body).not.toBe('')
    expect(body).toContain('transcriptVisibilityLatency.recordSent(')
    expect(body).toContain('TRANSCRIPT_TAIL_CHANNEL')
  })

  it('has a renderer consumer for the UPDATE kind too, not only for appends', () => {
    // The kinds are handled in different places — appends go through the page
    // accumulator, updates through an in-place row write — so a lane that grew
    // a second kind on the producer and not the consumer would emit frames the
    // renderer silently drops, and the streaming half would go quiet with no
    // error anywhere.
    const applier = source('src/renderer/src/lib/transcriptTailApplier.ts')
    expect(applier).toContain("kind === 'tail-update'")
    expect(applier).toContain('store.updateChatTranscriptRows(')
  })

  it('ROUTES the frame by chat interest instead of broadcasting to every window', () => {
    // Unrouted, a busy chat cost one structured clone per app window on every
    // append, and every window but one discarded the frame on arrival. The
    // regression this pins is the easy revert: swapping the routed send back
    // for the blanket one reads like a simplification.
    const body = functionBody(mainSource, 'function broadcastTranscriptTail(')
    expect(body).not.toBe('')
    expect(body).toContain('desktopWindows.broadcastWhere(')
    expect(body).toContain('chatUpdateInterestRouter.wantsTranscriptTail(')
    // The blanket broadcast must be gone, not merely joined.
    expect(body).not.toContain('desktopWindows.broadcast(')
  })

  it('keeps the chat-owned popout hop, which routing must not swallow', () => {
    // A chat popout is not in `desktopWindows` and registers no chat-update
    // interest, so it is addressed directly. Folding it into the routed
    // broadcast would drop every popout off the lane silently.
    const body = functionBody(mainSource, 'function broadcastTranscriptTail(')
    expect(body).toContain('workspacePopoutWindows.get(')
    expect(body).toContain('safeSendToWebContents(popout, TRANSCRIPT_TAIL_CHANNEL')
  })

  it('keeps the receipt off the send path — it must never gate a frame', () => {
    const body = functionBody(mainSource, 'function broadcastTranscriptTail(')
    // Guard the guard: without this, a renamed function makes `slice` return ''
    // and every `not.toContain` below passes over an empty string.
    expect(body).not.toBe('')
    expect(body.length).toBeGreaterThan(100)
    // If the producer ever waits on, checks, or retries against receipt-derived
    // state, this lane has become the acked envelope it exists to escape.
    expect(body).not.toContain('recordCommitted')
    expect(body).not.toContain('await')
    expect(body).not.toContain('setTimeout')
    expect(body).not.toContain('snapshot(')
    expect(body).not.toContain('pending')
  })

  it('publishes the visibility histogram beside the event-loop lag section', () => {
    expect(mainSource).toContain('transcriptVisibility: () => transcriptVisibilityLatency.snapshot')
    expect(mainSource).toContain('transcriptTail: () => transcriptTailBroadcaster.counterSnapshot')
  })
})
