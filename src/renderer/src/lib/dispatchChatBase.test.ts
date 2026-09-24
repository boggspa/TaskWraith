import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { resolveDispatchChatBase } from './dispatchChatBase'

function message(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: '1' }
}

function chat(messages: ChatMessage[], overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-dispatch',
    title: 'Dispatch base',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChatRecord
}

describe('resolveDispatchChatBase', () => {
  it('keeps rows that landed while the dispatch was awaiting composition', () => {
    // The reported loss: the snapshot was taken before `composeRun`, and the
    // tool row main appended during it exists only in the live map. Spreading
    // the snapshot dropped it, and the dispatch's `saveChat` made that durable.
    const snapshot = chat([message('a')])
    const live = chat([message('a'), message('tool-row')])

    expect(resolveDispatchChatBase(snapshot, live)).toBe(live)
  })

  it('falls back to the snapshot when no live record exists yet', () => {
    const snapshot = chat([message('a')])

    expect(resolveDispatchChatBase(snapshot, undefined)).toBe(snapshot)
    expect(resolveDispatchChatBase(snapshot, null)).toBe(snapshot)
  })

  it('refuses a catalogue row, which carries no transcript to dispatch from', () => {
    const snapshot = chat([message('a'), message('b')])
    const summary = chat([], { summaryOnly: true } as Partial<ChatRecord>)

    expect(resolveDispatchChatBase(snapshot, summary)).toBe(snapshot)
  })

  it('refuses a paged shell so its tail page is not saved over the history', () => {
    const snapshot = chat([message('a'), message('b'), message('c')])
    const shell = chat([message('c')], {
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 3
    } as Partial<ChatRecord>)

    expect(resolveDispatchChatBase(snapshot, shell)).toBe(snapshot)
  })

  it('refuses a record whose transcript arrays are missing entirely', () => {
    const snapshot = chat([message('a')])
    const armless = { appChatId: 'chat-dispatch', title: 'No arrays' } as unknown as ChatRecord

    expect(resolveDispatchChatBase(snapshot, armless)).toBe(snapshot)
  })

  it('refuses a live record belonging to a different chat', () => {
    const snapshot = chat([message('a')])
    const other = chat([message('a'), message('b')], { appChatId: 'chat-other' })

    expect(resolveDispatchChatBase(snapshot, other)).toBe(snapshot)
  })
})

/**
 * The wiring half. App.tsx has no DOM test environment here, so this follows
 * the established source-structure style (composerSteerButton.test.ts,
 * TranscriptPanel.userRowOrigin.test.ts).
 */
describe('executeRun dispatch base wiring', () => {
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('resolves the dispatch base from the live map, not the dispatch-entry snapshot', () => {
    expect(appSource).toContain(
      'const dispatchChatBase = resolveDispatchChatBase(\n' +
        '        runChat,\n' +
        '        chatByIdRef.current.get(runChat.appChatId)\n' +
        '      )'
    )
    // The shape this replaced: the non-mid-run branch spread `runChat`, the
    // snapshot taken before composeRun, and dropped everything appended since.
    expect(appSource).not.toContain('const dispatchChatBase = preAppendedPromptMessage')
  })

  it('leaves no await between resolving the base and saving the record', () => {
    // An await here re-opens the very window the live read closes: rows landing
    // during it are appended to an already-spread base and lost by the save.
    const start = appSource.indexOf('const dispatchChatBase = resolveDispatchChatBase(')
    const end = appSource.indexOf('window.api.saveChat(chatToUpdate)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(appSource.slice(start, end)).not.toMatch(/\bawait\b/)
  })

  it('keeps the visible-run reset ahead of the attachment-thumbnail await', () => {
    // The reset only needs the chat id, and moving it below the await would
    // delay the "Working" chip by one IPC per attachment.
    const reset = appSource.indexOf(
      'const isRunVisibleAtStart = selectedChatIdAtRunStart === runChat.appChatId'
    )
    const thumbnails = appSource.indexOf('const submittedImageThumbnails = authorsPromptMessage')
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(thumbnails).toBeGreaterThan(reset)
  })
})
