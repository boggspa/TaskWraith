import { describe, expect, it } from 'vitest'
import {
  buildLiveActivityApsBody,
  buildLiveActivityContentState,
  LIVE_ACTIVITY_ATTRIBUTES_TYPE,
  MAX_LIVE_ACTIVITY_SEATS,
  type LiveActivityPushPayload
} from './liveActivityPayload'

const CONTENT = buildLiveActivityContentState({
  phase: 'running',
  startedAtUnix: 1_700_000_000,
  filesChanged: 3,
  additions: 40,
  deletions: 5
})

function payload(over: Partial<LiveActivityPushPayload> = {}): LiveActivityPushPayload {
  return { event: 'update', contentState: CONTENT, collapseId: 'ref-1', needsUser: false, ...over }
}

describe('live activity content state', () => {
  it('is a whitelist — unnamed fields cannot survive', () => {
    const state = buildLiveActivityContentState({
      phase: 'running',
      startedAtUnix: 1,
      // Everything below is exactly what must NEVER reach an unencryptable
      // payload. Passing a whole card through must leak none of it.
      ...({ title: 'Fix the auth bug', path: '/Users/me/secret', threadId: 't-1' } as object)
    } as never)
    expect(Object.keys(state).sort()).toEqual([
      'activeRuns',
      'additions',
      'ahead',
      'behind',
      'deletions',
      'filesChanged',
      'hasGitSnapshot',
      'phase',
      'seats',
      'startedAtUnix'
    ])
  })

  it('caps seats at the ActivityKit limit', () => {
    const state = buildLiveActivityContentState({
      phase: 'running',
      startedAtUnix: 1,
      seats: Array.from({ length: 40 }, () => ({ provider: 'codex', phase: 'running' }))
    })
    expect(state.seats).toHaveLength(MAX_LIVE_ACTIVITY_SEATS)
  })

  it('clamps junk counts rather than forwarding them', () => {
    const state = buildLiveActivityContentState({
      phase: 'nonsense',
      startedAtUnix: 'soon',
      filesChanged: -4,
      additions: Number.NaN,
      deletions: 2.7
    })
    expect(state.phase).toBe('running')
    expect(state.startedAtUnix).toBe(0)
    expect(state).toMatchObject({ filesChanged: 0, additions: 0, deletions: 2 })
  })

  it('carries only anonymous workspace counters and distinguishes unavailable Git', () => {
    const state = buildLiveActivityContentState({
      phase: 'running',
      startedAtUnix: 1,
      activeRuns: 3,
      ahead: 8,
      behind: 2,
      hasGitSnapshot: true,
      ...({ workspaceId: 'secret-id', branch: 'secret-branch' } as object)
    } as never)
    expect(state).toMatchObject({ activeRuns: 3, ahead: 8, behind: 2, hasGitSnapshot: true })
    expect(JSON.stringify(state)).not.toContain('secret')
    expect(buildLiveActivityContentState({ phase: 'running', startedAtUnix: 1 })).toMatchObject({
      activeRuns: 1,
      hasGitSnapshot: false
    })
  })

  it('coerces a non-string provider so a malformed projection cannot smuggle an object', () => {
    const state = buildLiveActivityContentState({
      phase: 'running',
      startedAtUnix: 1,
      seats: [{ provider: { evil: true }, phase: 'complete' }]
    })
    expect(state.seats[0].provider).toBe('ensemble')
  })
})

describe('live activity aps body', () => {
  it('carries the timestamp iOS orders updates by', () => {
    // Two pushes with the same timestamp, or one older than what is on screen,
    // are DISCARDED by iOS — so a caller reusing a cached "now" across a burst
    // silently loses every update after the first.
    const aps = JSON.parse(buildLiveActivityApsBody(payload(), 1_700_000_500)).aps
    expect(aps.timestamp).toBe(1_700_000_500)
    expect(aps.event).toBe('update')
    expect(aps['content-state'].startedAtUnix).toBe(1_700_000_000)
  })

  it('sends startedAtUnix as a NUMBER, never a date string', () => {
    // A string here decodes to nothing on the Swift side; a Date-encoded double
    // decodes 31 years out. Both are silent.
    const aps = JSON.parse(buildLiveActivityApsBody(payload(), 1)).aps
    expect(typeof aps['content-state'].startedAtUnix).toBe('number')
  })

  it('a start event carries the attributes type ActivityKit matches on', () => {
    const body = buildLiveActivityApsBody(
      payload({
        event: 'start',
        attributes: {
          provider: 'codex',
          archetype: 'diff',
          palette: { accent: 0x705aff, success: 0x2db777, failure: 0xec3d35, attention: 0xf5a623 },
          activityRef: 'ref-1'
        }
      }),
      1
    )
    const aps = JSON.parse(body).aps
    expect(aps['attributes-type']).toBe(LIVE_ACTIVITY_ATTRIBUTES_TYPE)
    // iOS will not surface a push-started activity without an alert.
    expect(aps.alert).toBeTruthy()
  })

  it('refuses a start with no attributes instead of sending a push iOS will drop', () => {
    expect(() => buildLiveActivityApsBody(payload({ event: 'start' }), 1)).toThrow(/attributes/)
  })

  it('only an end event carries a dismissal date', () => {
    const ended = JSON.parse(
      buildLiveActivityApsBody(payload({ event: 'end', dismissAtUnix: 99 }), 1)
    ).aps
    expect(ended['dismissal-date']).toBe(99)
    const updated = JSON.parse(
      buildLiveActivityApsBody(payload({ event: 'update', dismissAtUnix: 99 }), 1)
    ).aps
    expect(updated['dismissal-date']).toBeUndefined()
  })

  it('a waiting run outranks a merely-running one', () => {
    expect(
      JSON.parse(buildLiveActivityApsBody(payload({ needsUser: true }), 1)).aps['relevance-score']
    ).toBe(2)
    expect(JSON.parse(buildLiveActivityApsBody(payload(), 1)).aps['relevance-score']).toBe(1)
  })
})
