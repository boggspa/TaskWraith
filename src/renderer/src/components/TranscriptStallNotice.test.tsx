import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptStallNotice } from './TranscriptStallNotice'
import {
  getTranscriptStallSnapshot,
  publishTranscriptStallState,
  resetTranscriptStallStoreForTests,
  subscribeTranscriptStall
} from '../lib/transcriptStallStore'

let clock = 0

beforeEach(() => {
  clock = 0
  resetTranscriptStallStoreForTests(() => clock)
})

afterEach(() => {
  resetTranscriptStallStoreForTests()
})

function render(chatId?: string | null): string {
  return renderToStaticMarkup(createElement(TranscriptStallNotice, { chatId }))
}

/** Main announced up to `announced` and the window has committed `settled`. */
function behindSince(chatId: string, atMs: number, announced = 2, settled = 1): void {
  publishTranscriptStallState(chatId, {
    announcedSequence: announced,
    settledSequence: settled,
    oldestUnsettledAtMs: atMs
  })
}

describe('TranscriptStallNotice', () => {
  it('renders nothing at all while the transcript is current', () => {
    expect(render('chat-1')).toBe('')
    behindSince('chat-1', 0, 3, 3)
    expect(render('chat-1')).toBe('')
  })

  it('renders nothing for a chat it has never heard of, or no chat', () => {
    expect(render('unknown')).toBe('')
    expect(render(null)).toBe('')
    expect(render(undefined)).toBe('')
  })

  it('stays silent below the warn threshold — ordinary scheduling is not news', () => {
    behindSince('chat-1', 0)
    clock = 900
    expect(render('chat-1')).toBe('')
  })

  it('says it is catching up once the gap is worth mentioning', () => {
    behindSince('chat-1', 0)
    clock = 2_000
    const markup = render('chat-1')
    expect(markup).toContain('Catching up on new messages')
    expect(markup).toContain('transcript-stall-notice--catching-up')
  })

  it('names the real number once the transcript is properly behind', () => {
    behindSince('chat-1', 0)
    clock = 8_000
    const markup = render('chat-1')
    expect(markup).toContain('Transcript is 8s behind')
    expect(markup).toContain('transcript-stall-notice--stalled')
    expect(markup).toContain('data-lag-ms="8000"')
  })

  it('reports the 2026-09-11 freeze in minutes, not as a spinner', () => {
    behindSince('chat-1', 0)
    clock = 116_000
    expect(render('chat-1')).toContain('Transcript is 1m 56s behind')
  })

  it('is a polite status region, so a screen reader is not interrupted mid-sentence', () => {
    behindSince('chat-1', 0)
    clock = 8_000
    const markup = render('chat-1')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })

  it('first paint is declarative — correct with no effect having run', () => {
    // Renderer suites have no jsdom: effects never run and refs never attach.
    // The notice must be right from the server-rendered markup alone.
    behindSince('chat-1', 0)
    clock = 6_000
    expect(render('chat-1')).toContain('Transcript is 6s behind')
  })
})

describe('transcriptStallStore snapshot stability', () => {
  it('returns the SAME object across reads within a second', () => {
    behindSince('chat-1', 0)
    clock = 8_000
    const first = getTranscriptStallSnapshot('chat-1')
    clock = 8_400
    const second = getTranscriptStallSnapshot('chat-1')
    // useSyncExternalStore compares getSnapshot results with Object.is; a fresh
    // object per read is an infinite re-render while the app is struggling.
    expect(second).toBe(first)
  })

  it('returns a new object only when the whole second changes', () => {
    behindSince('chat-1', 0)
    clock = 8_000
    const first = getTranscriptStallSnapshot('chat-1')
    clock = 9_000
    const second = getTranscriptStallSnapshot('chat-1')
    expect(second).not.toBe(first)
    expect(second.lagMs).toBe(9_000)
  })

  it('returns the shared current constant once the gap closes', () => {
    behindSince('chat-1', 0)
    clock = 8_000
    expect(getTranscriptStallSnapshot('chat-1').level).toBe('stalled')
    behindSince('chat-1', 8_000, 2, 2)
    expect(getTranscriptStallSnapshot('chat-1')).toBe(getTranscriptStallSnapshot('chat-2'))
  })

  it('notifies subscribers when state changes', () => {
    let notified = 0
    const unsubscribe = subscribeTranscriptStall('chat-1', () => {
      notified += 1
    })
    behindSince('chat-1', 0)
    expect(notified).toBe(1)
    // An identical republish is not a change and must not wake the UI.
    behindSince('chat-1', 0)
    expect(notified).toBe(1)
    unsubscribe()
    behindSince('chat-1', 5_000)
    expect(notified).toBe(1)
  })

  it('does not arm its ticker when nothing is behind', () => {
    const unsubscribe = subscribeTranscriptStall('chat-1', () => {})
    behindSince('chat-1', 0, 3, 3)
    // A chat that is current must not hold a per-second wakeup open.
    expect(getTranscriptStallSnapshot('chat-1').level).toBe('current')
    unsubscribe()
  })
})
