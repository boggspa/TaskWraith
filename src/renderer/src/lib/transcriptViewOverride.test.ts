import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TRANSCRIPT_VIEW,
  getTranscriptViewSnapshot,
  hasTranscriptViewOverride,
  resetTranscriptViewOverridesForTest,
  resolveTranscriptView,
  setTranscriptViewOverride,
  subscribeTranscriptView,
  transcriptViewForChat
} from './transcriptViewOverride'

afterEach(() => {
  resetTranscriptViewOverridesForTest()
})

describe('transcript view default', () => {
  it('renders everything out of the box', () => {
    expect(DEFAULT_TRANSCRIPT_VIEW).toBe('standard')
  })

  it('resolves absence to the default rather than to a hiding view', () => {
    // Absence is the common case, not an edge one: every install that upgrades
    // into this feature reaches here with `undefined`. Resolving that to
    // anything but `standard` would hide turns the user never asked to hide,
    // and there is nothing on screen to explain where the work went.
    expect(resolveTranscriptView(undefined)).toBe('standard')
    expect(resolveTranscriptView(null)).toBe('standard')
  })

  it('honours each explicit view', () => {
    expect(resolveTranscriptView('minimal')).toBe('minimal')
    expect(resolveTranscriptView('tools')).toBe('tools')
    expect(resolveTranscriptView('standard')).toBe('standard')
  })

  it('falls back for a value it does not recognise', () => {
    // A hand-edited settings file, or a downgrade from a build that grew a
    // fourth view. Either way the DOM carries an attribute that matches no
    // rule, so the safe landing is the view that hides nothing.
    expect(resolveTranscriptView('verbose')).toBe('standard')
    expect(resolveTranscriptView(3)).toBe('standard')
    expect(resolveTranscriptView({ view: 'minimal' })).toBe('standard')
  })
})

describe('per-chat transcript view overrides', () => {
  it('follows the supplied default until a chat overrides', () => {
    expect(transcriptViewForChat(getTranscriptViewSnapshot(), 'chat-a', 'tools')).toBe('tools')
  })

  it('serves one chat its override while another keeps the default', () => {
    setTranscriptViewOverride('chat-a', 'minimal')
    const snapshot = getTranscriptViewSnapshot()
    expect(transcriptViewForChat(snapshot, 'chat-a', 'standard')).toBe('minimal')
    expect(transcriptViewForChat(snapshot, 'chat-b', 'standard')).toBe('standard')
  })

  it('gives every mount of one chat the same answer', () => {
    // The main pane, the side chat and a multiview pane can all hold the same
    // chat at once. They read one snapshot, so they cannot disagree — this is
    // the reason the store is keyed by chat and lives outside the React tree.
    setTranscriptViewOverride('chat-a', 'tools')
    const snapshot = getTranscriptViewSnapshot()
    const mounts = [snapshot, snapshot, snapshot].map((s) =>
      transcriptViewForChat(s, 'chat-a', 'standard')
    )
    expect(mounts).toEqual(['tools', 'tools', 'tools'])
  })

  it('resolves an absent chat id to the default, never to a stray empty key', () => {
    // A pane can render before its chat resolves, and `appChatId` is '' rather
    // than null on a record that has not been hydrated yet. Both must reach
    // the default: keying a live transcript off an override stored under ''
    // would let one unidentified pane dictate the view for every other one.
    setTranscriptViewOverride('', 'minimal')
    expect(transcriptViewForChat(getTranscriptViewSnapshot(), null, 'standard')).toBe('standard')
    expect(transcriptViewForChat(getTranscriptViewSnapshot(), '', 'standard')).toBe('standard')
    expect(hasTranscriptViewOverride(getTranscriptViewSnapshot(), '')).toBe(false)
  })

  it('clears an override back to the default', () => {
    setTranscriptViewOverride('chat-a', 'minimal')
    setTranscriptViewOverride('chat-a', null)
    expect(transcriptViewForChat(getTranscriptViewSnapshot(), 'chat-a', 'tools')).toBe('tools')
    expect(hasTranscriptViewOverride(getTranscriptViewSnapshot(), 'chat-a')).toBe(false)
  })

  it('distinguishes an override that matches the default from no override', () => {
    // A menu marks the chat as overridden, and "standard because I chose it"
    // has to survive a later change to the Appearance default.
    setTranscriptViewOverride('chat-a', 'standard')
    expect(hasTranscriptViewOverride(getTranscriptViewSnapshot(), 'chat-a')).toBe(true)
    expect(transcriptViewForChat(getTranscriptViewSnapshot(), 'chat-a', 'minimal')).toBe('standard')
  })
})

describe('transcript view store subscription', () => {
  it('publishes a new snapshot reference on every change', () => {
    // useSyncExternalStore compares by reference. Mutating the existing Map
    // would leave every subscriber reading a value it believes it has already
    // rendered, which reads as "the menu does nothing".
    const before = getTranscriptViewSnapshot()
    setTranscriptViewOverride('chat-a', 'minimal')
    expect(getTranscriptViewSnapshot()).not.toBe(before)
  })

  it('notifies subscribers when a chat changes view', () => {
    const listener = vi.fn()
    subscribeTranscriptView(listener)
    setTranscriptViewOverride('chat-a', 'minimal')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stays silent when a chat is set to the view it already has', () => {
    // Every transcript mount re-renders on notify, so a no-op write must not
    // reach the listeners.
    setTranscriptViewOverride('chat-a', 'minimal')
    const listener = vi.fn()
    subscribeTranscriptView(listener)
    setTranscriptViewOverride('chat-a', 'minimal')
    expect(listener).not.toHaveBeenCalled()
    expect(getTranscriptViewSnapshot().get('chat-a')).toBe('minimal')
  })

  it('stays silent when clearing a chat that has no override', () => {
    const listener = vi.fn()
    subscribeTranscriptView(listener)
    setTranscriptViewOverride('chat-a', null)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    subscribeTranscriptView(listener)()
    setTranscriptViewOverride('chat-a', 'minimal')
    expect(listener).not.toHaveBeenCalled()
  })
})
