import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bubbleClass,
  mergeOlderPage,
  parseHumanCollaborationInvite,
  seatAccentClass
} from './JoinSharedChatModal'

const invite = {
  type: 'taskwraith-human-collaboration-invite',
  v: 1,
  shareId: 'share-1',
  chatId: 'chat-1',
  inviteToken: 'token-1',
  mode: 'comments',
  relayUrl: 'wss://host.example',
  relayUrls: ['wss://host.example', 'ws://192.168.1.5:8787'],
  roomId: 'room-1',
  hostIdentityPubKeyB64: 'host-key'
}

describe('parseHumanCollaborationInvite', () => {
  it('accepts current JSON invites with relay candidates', () => {
    const parsed = parseHumanCollaborationInvite(JSON.stringify(invite))
    expect(parsed.shareId).toBe('share-1')
    expect(parsed.relayUrl).toBe('wss://host.example')
    expect(parsed.relayUrls).toEqual(['wss://host.example', 'ws://192.168.1.5:8787'])
  })

  it('accepts link invites with an encoded JSON payload', () => {
    const encoded = encodeURIComponent(JSON.stringify(invite))
    const parsed = parseHumanCollaborationInvite(`taskwraith://join-shared-chat?invite=${encoded}`)
    expect(parsed.roomId).toBe('room-1')
    expect(parsed.hostIdentityPubKeyB64).toBe('host-key')
  })

  it('rejects missing required room coordinates instead of dialing undefined', () => {
    expect(() =>
      parseHumanCollaborationInvite(JSON.stringify({ ...invite, roomId: undefined }))
    ).toThrow(/missing required share information/)
  })

  it('rejects invites with no relay candidates', () => {
    expect(() =>
      parseHumanCollaborationInvite(
        JSON.stringify({ ...invite, relayUrl: undefined, relayUrls: [] })
      )
    ).toThrow(/no connection info/)
  })
})

/**
 * The modal itself renders through `createPortal`, which has no server
 * renderer and no DOM environment in this repo — so the parity rules are
 * pinned at the pure functions that decide them.
 */
describe('collaborator projection presentation', () => {
  it('renders your own words as your bubbles and everyone else as named output', () => {
    // The rule the projection's `youAre` field exists to make possible. Without
    // it every collaborator row looked identical no matter who wrote it, so an
    // external could not tell their own message from the other guest's.
    expect(bubbleClass('collaborator', true)).toContain('join-projection-own')
    expect(bubbleClass('collaborator', false)).not.toContain('join-projection-own')
    expect(bubbleClass('collaborator', false)).toContain('human-collaborator-comment')
    // Self wins over role: your own row is yours whatever seat it came from.
    expect(bubbleClass('host', true)).toContain('join-projection-own')
    // Everyone else keeps their own presentation.
    expect(bubbleClass('host', false)).toBe('message-bubble user')
    expect(bubbleClass('assistant', false)).toBe('message-bubble assistant')
    expect(bubbleClass('placeholder', false)).toContain('join-projection-placeholder')
  })

  it('only ever emits a palette INDEX class, never a value off the wire', () => {
    // `colorIndex` is a number rather than a colour name precisely because it
    // crosses from an untrusted host and lands in a class attribute. Anything
    // that is not a real palette index must produce no class at all.
    expect(seatAccentClass(0)).toBe(' join-seat-color-0')
    expect(seatAccentClass(7)).toBe(' join-seat-color-7')
    expect(seatAccentClass(8)).toBe('')
    expect(seatAccentClass(-1)).toBe('')
    expect(seatAccentClass(1.5)).toBe('')
    expect(seatAccentClass(undefined)).toBe('')
    expect(seatAccentClass(NaN)).toBe('')
    // The shapes that would matter if this ever became a string concat.
    expect(seatAccentClass('0' as unknown as number)).toBe('')
    expect(seatAccentClass('0" onload="alert(1)' as unknown as number)).toBe('')
  })
})

/**
 * L-3. A page is CLIENT-HELD, so a host-side truncation cannot reach rows
 * already on this machine. What a truncation does is drop the room, which
 * forces a re-handshake, which mints a new sessionId — so the session check
 * below is the only thing standing between "erased" and "erased everywhere it
 * was served". TW-SEC-014 is the precedent.
 */
describe('older-page cache discards across a re-handshake', () => {
  const row = (id: string) =>
    ({ id, role: 'host', speaker: 'Host', preview: id, truncated: false, timestamp: 't' }) as never

  it('DISCARDS everything held when the session changes — never merges', () => {
    const before = mergeOlderPage(null, {
      sessionId: 'session-before-truncate',
      rows: [row('erased-1'), row('erased-2')],
      hasMore: true,
      oldestRowId: 'erased-1'
    })
    expect(before.rows.map((r) => r.id)).toEqual(['erased-1', 'erased-2'])

    // The host truncated; the room dropped; the client re-handshook and got a
    // new session. The page that arrives now belongs to that new session.
    const after = mergeOlderPage(before, {
      sessionId: 'session-after-truncate',
      rows: [row('kept-1')],
      hasMore: false,
      oldestRowId: 'kept-1'
    })

    expect(after.sessionId).toBe('session-after-truncate')
    // THE assertion: not one erased row survived, and the count proves it is a
    // replacement rather than a merge that happened to reorder.
    expect(after.rows.map((r) => r.id)).toEqual(['kept-1'])
    expect(after.rows).toHaveLength(1)
    expect(JSON.stringify(after)).not.toContain('erased')
  })

  it('accumulates within ONE session, oldest page on top', () => {
    // The guard must not be so blunt that paging never accumulates — that would
    // pass the test above while making the feature useless.
    const first = mergeOlderPage(null, {
      sessionId: 's1',
      rows: [row('b')],
      hasMore: true,
      oldestRowId: 'b'
    })
    const second = mergeOlderPage(first, {
      sessionId: 's1',
      rows: [row('a')],
      hasMore: false,
      oldestRowId: 'a'
    })
    expect(second.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(second.hasMore).toBe(false)
    expect(second.oldestRowId).toBe('a')
  })

  it('a throttled page keeps the cursor and never claims the top of the thread', () => {
    // An empty page with no flag reads as "you have reached the start". Saying
    // that when the request was merely refused for rate would be paging lying
    // about where the conversation began.
    const held = mergeOlderPage(null, {
      sessionId: 's1',
      rows: [row('b')],
      hasMore: true,
      oldestRowId: 'b'
    })
    const throttled = mergeOlderPage(held, {
      sessionId: 's1',
      rows: [],
      hasMore: true,
      throttled: true
    })
    expect(throttled.rows.map((r) => r.id)).toEqual(['b'])
    expect(throttled.oldestRowId).toBe('b')
    expect(throttled.hasMore).toBe(true)

    // And a throttled page for a DIFFERENT session still discards.
    const crossed = mergeOlderPage(held, {
      sessionId: 's2',
      rows: [],
      hasMore: true,
      throttled: true
    })
    expect(crossed.sessionId).toBe('s2')
    expect(crossed.rows).toEqual([])
    expect(crossed.oldestRowId).toBeUndefined()
  })

  it('prefers the incoming copy of a row it already holds', () => {
    // Redaction runs per build from the live record, so a re-served row is the
    // freshly-redacted one. A stale cached copy must never win.
    const held = mergeOlderPage(null, {
      sessionId: 's1',
      rows: [{ ...(row('x') as object), preview: 'STALE' } as never],
      hasMore: true,
      oldestRowId: 'x'
    })
    const refreshed = mergeOlderPage(held, {
      sessionId: 's1',
      rows: [{ ...(row('x') as object), preview: 'FRESH' } as never],
      hasMore: false,
      oldestRowId: 'x'
    })
    expect(refreshed.rows).toHaveLength(1)
    expect((refreshed.rows[0] as { preview: string }).preview).toBe('FRESH')
  })
})

/**
 * The last hop the other tests cannot reach.
 *
 * `mergeOlderPage` is proven by unit test and the wire is proven end-to-end over
 * a real relay — but the modal renders through `createPortal`, which has no
 * server renderer and no DOM environment here, so nothing else can assert that
 * the component actually CONNECTS the two. A lane that is correct at both ends
 * and wired at neither is this repo's most repeated defect, so it gets a
 * source-region pin, the same shape as `externalSeatChip.test.ts`.
 */
describe('the modal actually wires paging up', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/JoinSharedChatModal.tsx'),
    'utf8'
  )

  it('feeds arriving pages through mergeOlderPage, not into raw state', () => {
    expect(source).toContain('onHumanCollaborationCollaboratorOlderPage')
    expect(source).toContain('setOlderPages((current) =>')
    expect(source).toContain('mergeOlderPage(current, {')
  })

  it('drops the cache when a projection arrives from a different session', () => {
    // The second half of L-3: a re-handshake is observed here, not only on a
    // page. Without it a truncated session that never pages again would keep
    // showing rows from the session before it.
    expect(source).toContain('current && current.sessionId !== payload.sessionId ? null : current')
  })

  it('asks with the oldest row it holds, so paging walks backwards', () => {
    expect(source).toContain('humanCollaborationCollaboratorLoadOlder')
    expect(source).toContain('olderPages?.oldestRowId ?? projection?.rows[0]?.id')
  })

  it('only claims the top of the thread when a page said so', () => {
    // `canLoadOlder` must come from what a page reported, never from a bare
    // empty-rows check — a page refused for rate has empty rows and says
    // nothing about the thread.
    expect(source).toContain('const canLoadOlder = olderPages')
    expect(source).toContain('? olderPages.hasMore')
  })
})
