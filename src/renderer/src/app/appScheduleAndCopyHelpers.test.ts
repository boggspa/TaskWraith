import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendMessageContentToPromptDraft,
  compactShortcutHint,
  hasGitSnapshotSubscriptionApi,
  runIdFromStreamFlushItemKey,
  scheduleAfterNextPaint,
  scheduleAfterPaint,
  streamFlushItemKey
} from './appScheduleAndCopyHelpers'

function stubWindowApi(api: unknown): void {
  ;(globalThis as unknown as { window: unknown }).window = { api }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('streamFlushItemKey', () => {
  it('joins run and item ids and round-trips the run id', () => {
    const key = streamFlushItemKey('run-1', 'item-9')
    expect(key).toContain('run-1')
    expect(key).toContain('item-9')
    expect(runIdFromStreamFlushItemKey(key)).toBe('run-1')
  })

  it('tolerates a missing item id', () => {
    expect(runIdFromStreamFlushItemKey(streamFlushItemKey('run-2'))).toBe('run-2')
  })
})

describe('runIdFromStreamFlushItemKey', () => {
  it('returns the whole key when no separator is present', () => {
    expect(runIdFromStreamFlushItemKey('bare-run')).toBe('bare-run')
  })
})

describe('compactShortcutHint', () => {
  it('renders nothing for empty or unassigned bindings', () => {
    expect(compactShortcutHint([])).toBe('')
    expect(compactShortcutHint(['Unassigned'])).toBe('')
  })

  it('compresses modifier names and joins without separators', () => {
    expect(compactShortcutHint(['Cmd/Ctrl', 'Shift', 'Alt', 'K'])).toBe('⌘⇧⌥K')
  })
})

describe('appendMessageContentToPromptDraft', () => {
  it('keeps previous when the addition is blank', () => {
    expect(appendMessageContentToPromptDraft('hello', '   ')).toBe('hello')
  })

  it('returns the addition when previous is blank', () => {
    expect(appendMessageContentToPromptDraft('  ', 'hi')).toBe('hi')
  })

  it('separates with exactly two newlines by default', () => {
    expect(appendMessageContentToPromptDraft('a', 'b')).toBe('a\n\nb')
    expect(appendMessageContentToPromptDraft('a\n', 'b')).toBe('a\n\nb')
    expect(appendMessageContentToPromptDraft('a\n\n', 'b')).toBe('a\n\nb')
  })
})

describe('scheduleAfterPaint', () => {
  it('returns a callable cleanup without invoking the callback synchronously', () => {
    const callback = vi.fn()
    const cancel = scheduleAfterPaint(callback)
    expect(typeof cancel).toBe('function')
    expect(callback).not.toHaveBeenCalled()
    cancel()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('scheduleAfterNextPaint', () => {
  it('returns a callable cleanup without invoking the callback synchronously', () => {
    const callback = vi.fn()
    const cancel = scheduleAfterNextPaint(callback)
    expect(typeof cancel).toBe('function')
    expect(callback).not.toHaveBeenCalled()
    cancel()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('hasGitSnapshotSubscriptionApi', () => {
  it('is true when the bridge exposes gitSubscribeSnapshot', () => {
    stubWindowApi({ gitSubscribeSnapshot: () => undefined })
    expect(hasGitSnapshotSubscriptionApi()).toBe(true)
  })

  it('is false when the bridge omits gitSubscribeSnapshot', () => {
    stubWindowApi({})
    expect(hasGitSnapshotSubscriptionApi()).toBe(false)
  })
})
