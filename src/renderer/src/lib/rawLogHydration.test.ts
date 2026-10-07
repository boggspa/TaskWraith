import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  mergeHydratedRawLogs,
  shouldHydrateThreadRawLogs,
  type ThreadRawLogHydrationState
} from './rawLogHydration'

const state = (
  overrides: Partial<ThreadRawLogHydrationState> = {}
): ThreadRawLogHydrationState => ({
  hydrated: false,
  inFlight: false,
  hasBuffer: false,
  hasRunEventsApi: true,
  presentationVisible: true,
  ...overrides
})

describe('shouldHydrateThreadRawLogs', () => {
  // Thread select used to fetch run events for every chat opened, which made
  // main parse the whole chat record plus up to 120 run-event files to fill a
  // panel that was closed. History now waits for the panel.
  it('does not fetch while the raw-log presentation is hidden', () => {
    expect(shouldHydrateThreadRawLogs(state({ presentationVisible: false }))).toBe(false)
    expect(shouldHydrateThreadRawLogs(state({ presentationVisible: false, hasBuffer: true }))).toBe(
      false
    )
  })

  // THE BUG. `appendThreadRawLog` creates a buffer for the first
  // renderer-authored line, and the old guard was buffer presence alone -- so
  // one locally-emitted log permanently suppressed run-event hydration for that
  // thread and its durable history never loaded again.
  it('still hydrates a chat that only has renderer-authored lines', () => {
    expect(shouldHydrateThreadRawLogs(state({ hasBuffer: true }))).toBe(true)
  })

  it('does not re-fetch a chat already hydrated and still held', () => {
    expect(shouldHydrateThreadRawLogs(state({ hydrated: true, hasBuffer: true }))).toBe(false)
  })

  // Raw-log buffers are evicted under retention pressure. An evicted thread has
  // no logs at all, so it must be allowed to hydrate again.
  it('hydrates again once an already-hydrated buffer has been evicted', () => {
    expect(shouldHydrateThreadRawLogs(state({ hydrated: true, hasBuffer: false }))).toBe(true)
  })

  it('never runs two fetches for the same chat at once', () => {
    expect(shouldHydrateThreadRawLogs(state({ inFlight: true }))).toBe(false)
    expect(shouldHydrateThreadRawLogs(state({ inFlight: true, hasBuffer: true }))).toBe(false)
  })

  it('does nothing without the run-events bridge', () => {
    expect(shouldHydrateThreadRawLogs(state({ hasRunEventsApi: false }))).toBe(false)
  })

  it('hydrates a cold chat', () => {
    expect(shouldHydrateThreadRawLogs(state())).toBe(true)
  })
})

describe('mergeHydratedRawLogs', () => {
  it('keeps renderer-authored lines that arrived before hydration finished', () => {
    expect(mergeHydratedRawLogs(['h1', 'h2'], ['live'], 10)).toEqual(['h1', 'h2', 'live'])
  })

  it('orders history before live lines', () => {
    expect(mergeHydratedRawLogs(['h1'], ['l1', 'l2'], 10)).toEqual(['h1', 'l1', 'l2'])
  })

  it('drops the oldest when the capacity limit bites, keeping live lines', () => {
    expect(mergeHydratedRawLogs(['h1', 'h2', 'h3'], ['l1'], 2)).toEqual(['h3', 'l1'])
  })

  it('never discards live lines in favour of history', () => {
    expect(mergeHydratedRawLogs(['h1', 'h2', 'h3'], ['l1', 'l2'], 2)).toEqual(['l1', 'l2'])
  })

  it('handles either side being empty', () => {
    expect(mergeHydratedRawLogs([], ['l1'], 10)).toEqual(['l1'])
    expect(mergeHydratedRawLogs(['h1'], [], 10)).toEqual(['h1'])
    expect(mergeHydratedRawLogs([], [], 10)).toEqual([])
  })

  it('returns nothing for a non-positive limit rather than a negative slice', () => {
    expect(mergeHydratedRawLogs(['h1'], ['l1'], 0)).toEqual([])
    expect(mergeHydratedRawLogs(['h1'], ['l1'], -5)).toEqual([])
  })
})

describe('App.tsx hydrates through the guard rather than buffer presence', () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const squash = (text: string): string => text.replace(/\s+/g, '')
  const squashed = squash(source)

  it('asks shouldHydrateThreadRawLogs, passing buffer presence as one input', () => {
    expect(squashed).toContain(squash('shouldHydrateThreadRawLogs({'))
    expect(squashed).toContain(squash('hasBuffer: rawLogsByChatIdRef.current.has(chatId)'))
    expect(squashed).toContain(squash('hydrated: rawLogHydratedRef.current.has(chatId)'))
  })

  // Visibility is the renderer's existing raw-log presentation gate; hydration
  // reads it through the guard and the visibility effect is what triggers the
  // fetch, so opening the Raw Events tab on a thread loads its history and
  // selecting a thread with the tab closed costs main nothing.
  it('passes raw-log presentation visibility and hydrates when the panel opens', () => {
    expect(squashed).toContain(squash('presentationVisible: rawLogPresentationVisibleRef.current'))
    expect(squashed).toContain(
      squash(`setRawLogs(rawLogSnapshotForChat(chatId, true))
        hydrateThreadRawLogsFromEvents(chatId)
      }, [rightTab, showGeminiTerminal, currentChat?.appChatId])`)
    )
  })

  it('no longer hydrates run events from thread select', () => {
    expect(squashed).not.toContain(
      squash(`requestUsageSummaryRefresh(getUsageWorkspaceIdForChat(selectedChat), provider)
      hydrateThreadRawLogsFromEvents(selectedChat.appChatId)`)
    )
  })

  // The exact guard that caused the bug: buffer presence OR'd straight into the
  // early return, so the first renderer-authored line closed hydration for good.
  it('no longer short-circuits on buffer presence alone', () => {
    expect(squashed).not.toContain(
      squash(`rawLogsByChatIdRef.current.has(chatId) ||
              rawLogHydrationInFlightRef.current.has(chatId)`)
    )
  })

  it('merges rather than replacing, and records that the chat was hydrated', () => {
    expect(squashed).toContain(squash('mergeHydratedRawLogs(logs, existing, 1000)'))
    expect(squashed).toContain(squash('rawLogHydratedRef.current.add(chatId)'))
  })
})
