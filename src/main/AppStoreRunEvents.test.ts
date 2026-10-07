import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore, HistoryDeletionMutationBlockedError } from './store'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-run-events-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

describe('AppStore run events', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('does not persist provider stream artifacts when raw events are disabled', () => {
    const record = AppStore.appendRunEvent({
      runId: 'run-raw-off',
      provider: 'gemini',
      kind: 'provider_raw',
      phase: 'raw',
      source: 'provider',
      payload: { data: 'secret-ish provider stream token=abc1234567890\n' }
    })

    expect(record.artifacts).toBeUndefined()
    expect(record.payload).toMatchObject({
      redacted: true
    })
    expect(fs.existsSync(join(userDataPath, 'run-artifacts', 'run-raw-off', 'stdout.log'))).toBe(
      false
    )
  })

  it('persists a strict reference-context append before returning its record', () => {
    const runEventsDir = join(userDataPath, 'run-events')
    fs.mkdirSync(runEventsDir, { recursive: true })

    const record = AppStore.appendRunEvent(
      {
        runId: 'run-reference',
        chatId: 'chat-reference',
        kind: 'reference_context',
        phase: 'artifact',
        source: 'main'
      },
      { durability: 'strict' }
    )

    expect(AppStore.getRunEvents({ runId: 'run-reference' })).toContainEqual(record)
  })

  it('persists redacted provider stream artifacts when raw events are enabled', () => {
    AppStore.updateSettings({ storeRawEvents: true })

    const record = AppStore.appendRunEvent({
      runId: 'run-raw-on',
      provider: 'gemini',
      kind: 'provider_raw',
      phase: 'raw',
      source: 'provider',
      payload: { data: 'provider stream token=abc1234567890 persisted\n' }
    })

    expect(record.artifacts).toHaveLength(1)
    expect(record.artifacts?.[0]).toMatchObject({
      kind: 'stdout',
      path: 'run-raw-on/stdout.log'
    })
    expect(
      fs.readFileSync(join(userDataPath, 'run-artifacts', 'run-raw-on', 'stdout.log'), 'utf8')
    ).toBe('provider stream token=[redacted] persisted\n')
    expect(JSON.stringify(record.payload)).not.toContain('abc1234567890')
  })

  it('scopes a {chatId} query to the chat own run files — never the full-dir sweep', async () => {
    // chatA owns run r1. An ORPHAN event file carries chatId 'chatA' but its run
    // is NOT in chatA.runs (the old full-dir sweep would have included it; the
    // scoped read must not). r2 belongs to a different chat and must never be read
    // for chatA — that read is the multi-second main-thread beachball this fixes.
    AppStore.saveChat({
      appChatId: 'chatA',
      scope: 'workspace',
      chatKind: 'single',
      provider: 'gemini',
      title: 'A',
      workspaceId: 'ws',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [
        { runId: 'r1', provider: 'gemini', startedAt: '2026-01-01T00:00:00.000Z', status: 'success' }
      ]
    } as never)
    const ev = (runId: string, chatId: string): void => {
      AppStore.appendRunEvent({
        runId,
        chatId,
        provider: 'gemini',
        kind: 'provider_raw',
        phase: 'raw',
        source: 'provider',
        payload: { data: 'x\n' }
      } as never)
    }
    ev('r1', 'chatA')
    ev('orphan', 'chatA') // chatId matches but the run is not in chatA.runs
    ev('r2', 'chatB') // a different chat's run

    const runIds = AppStore.getRunEvents({ chatId: 'chatA' }).map((e) => e.runId)
    expect(runIds).toContain('r1')
    expect(runIds).not.toContain('r2') // another chat's file is never swept
    expect(runIds).not.toContain('orphan') // scoped to chatA.runs, not every chatId-matching file

    // The async twin (used by the get-run-events IPC handler) returns the same set.
    const asyncRunIds = (await AppStore.getRunEventsAsync({ chatId: 'chatA' })).map((e) => e.runId)
    expect(asyncRunIds).toEqual(runIds)
  })

  it('returns the same events for an unscoped {kinds} sweep as an unfiltered read', async () => {
    // The startup Project-reference reconcile queries {kinds:['reference_context']}
    // with no runId/chatId, which takes the whole-dir sweep. That sweep now skips
    // JSON.parse on lines that cannot match — this pins that the skip is a pure
    // optimization and never drops a real match.
    const ev = (runId: string, kind: string, payload?: unknown): void => {
      AppStore.appendRunEvent({
        runId,
        chatId: `chat-${runId}`,
        provider: 'gemini',
        kind,
        phase: kind === 'provider_raw' ? 'raw' : 'artifact',
        source: 'main',
        ...(payload === undefined ? {} : { payload })
      } as never)
    }
    // Bulk noise of the kind that dominates a real corpus (~89% of lines).
    for (let i = 0; i < 25; i += 1) ev(`noise-${i}`, 'provider_raw', { data: 'x\n' })
    ev('ref-1', 'reference_context')
    ev('ref-2', 'reference_context')
    ev('tool-1', 'tool')
    // A NON-matching event whose payload merely mentions the kind string. The
    // prefilter lets this line through; the real kind check must still reject it.
    ev('decoy', 'provider_raw', { data: 'mentions "kind":"reference_context" inline' })

    const swept = await AppStore.getRunEventsAsync({ kinds: ['reference_context'] } as never)
    expect(swept.map((e) => e.runId).sort()).toEqual(['ref-1', 'ref-2'])
    expect(swept.every((e) => e.kind === 'reference_context')).toBe(true)

    // Ground truth: filtering an unfiltered sweep in memory must agree exactly.
    const viaFullSweep = (await AppStore.getRunEventsAsync({}))
      .filter((e) => e.kind === 'reference_context')
      .map((e) => e.runId)
      .sort()
    expect(swept.map((e) => e.runId).sort()).toEqual(viaFullSweep)

    // The sync twin takes the same path and must agree.
    expect(
      AppStore.getRunEvents({ kinds: ['reference_context'] } as never)
        .map((e) => e.runId)
        .sort()
    ).toEqual(viaFullSweep)

    // Multi-kind queries keep every requested kind.
    const multi = await AppStore.getRunEventsAsync({
      kinds: ['reference_context', 'tool']
    } as never)
    expect(multi.map((e) => e.runId).sort()).toEqual(['ref-1', 'ref-2', 'tool-1'])
  })

  it('reads ALL of an ensemble chat runs (no early-stop) so interleaved-timestamp siblings keep newest ordering', () => {
    // Ensemble rounds run participants CONCURRENTLY under one chatId with
    // interleaved timestamps. runs=[rNewer, rOlder] → reverse() reads rOlder FIRST;
    // an early-stop at `limit` would return rOlder's (older) events and drop
    // rNewer's newer ones. The fix reads both and lets filterRunEvents' timestamp
    // sort + slice(-limit) pick the truly-newest events.
    AppStore.saveChat({
      appChatId: 'ens',
      scope: 'workspace',
      chatKind: 'ensemble',
      provider: 'gemini',
      title: 'E',
      workspaceId: 'ws',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [
        { runId: 'rNewer', provider: 'gemini', startedAt: '2026-01-01T00:00:02.000Z', status: 'success' },
        { runId: 'rOlder', provider: 'gemini', startedAt: '2026-01-01T00:00:01.000Z', status: 'success' }
      ]
    } as never)
    const ev = (runId: string, ms: number): void => {
      AppStore.appendRunEvent({
        runId,
        chatId: 'ens',
        provider: 'gemini',
        kind: 'provider_raw',
        phase: 'raw',
        source: 'provider',
        payload: { data: 'x\n' },
        timestamp: new Date(ms).toISOString()
      } as never)
    }
    // rOlder is read first (last in runs[] → reverse) but carries OLDER timestamps.
    ev('rOlder', 1000)
    ev('rOlder', 1001)
    ev('rOlder', 1002)
    ev('rNewer', 2000)
    ev('rNewer', 2001)
    ev('rNewer', 2002)

    // limit:3 — the newest 3 are all rNewer's; an early-stop would wrongly return rOlder's.
    const runIds = AppStore.getRunEvents({ chatId: 'ens', limit: 3 }).map((e) => e.runId)
    expect(runIds).toEqual(['rNewer', 'rNewer', 'rNewer'])
  })

  it('skips a run file that cannot rank in the newest {limit} and still returns the exact newest set', async () => {
    // runs=[rOld, rNew] → reverse() reads rNew FIRST. Once rNew alone supplies
    // `limit` accepted events, rOld's file (whose newest event is older than
    // the oldest kept) is never read in full: its tail is probed and it is
    // skipped. The result must still equal the unbounded read exactly.
    AppStore.saveChat({
      appChatId: 'big',
      scope: 'workspace',
      chatKind: 'single',
      provider: 'gemini',
      title: 'B',
      workspaceId: 'ws',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [
        { runId: 'rOld', provider: 'gemini', startedAt: '2026-01-01T00:00:01.000Z', status: 'success' },
        { runId: 'rNew', provider: 'gemini', startedAt: '2026-01-01T00:00:02.000Z', status: 'success' }
      ]
    } as never)
    const ev = (runId: string, ms: number, kind = 'provider_raw'): void => {
      AppStore.appendRunEvent({
        runId,
        chatId: 'big',
        provider: 'gemini',
        kind,
        phase: kind === 'provider_raw' ? 'raw' : 'artifact',
        source: 'provider',
        payload: { data: 'x\n' },
        timestamp: new Date(ms).toISOString()
      } as never)
    }
    ev('rOld', 1000)
    ev('rOld', 1001)
    ev('rOld', 1002)
    ev('rNew', 2000)
    ev('rNew', 2001)
    ev('rNew', 2002, 'tool') // a kind the query does not ask for must not count toward the bound
    ev('rNew', 2003)

    const readFile = vi.spyOn(fs.promises, 'readFile')
    try {
      const bounded = await AppStore.getRunEventsAsync({
        chatId: 'big',
        kinds: ['provider_raw'],
        limit: 3
      } as never)
      expect(bounded.map((e) => [e.runId, e.timestamp])).toEqual(
        AppStore.getRunEvents({ chatId: 'big', kinds: ['provider_raw'], limit: 3 } as never).map(
          (e) => [e.runId, e.timestamp]
        )
      )
      expect(bounded.map((e) => e.runId)).toEqual(['rNew', 'rNew', 'rNew'])
      const fullyRead = readFile.mock.calls.map((call) => String(call[0]))
      expect(fullyRead.some((p) => p.includes('rNew'))).toBe(true)
      expect(fullyRead.some((p) => p.includes('rOld'))).toBe(false)
    } finally {
      readFile.mockRestore()
    }

    // The interleaved-sibling case: rOld's file carries the NEWER events, so its
    // tail is newer than the oldest kept and it is read in full. Same answer as
    // the sync twin, which never skips.
    ev('rOld', 3000)
    ev('rOld', 3001)
    ev('rOld', 3002)
    const interleaved = await AppStore.getRunEventsAsync({ chatId: 'big', limit: 3 } as never)
    expect(interleaved.map((e) => e.runId)).toEqual(['rOld', 'rOld', 'rOld'])
    expect(interleaved.map((e) => e.timestamp)).toEqual(
      AppStore.getRunEvents({ chatId: 'big', limit: 3 } as never).map((e) => e.timestamp)
    )
  })

  it('does not close the newest {limit} bound until enough events of the queried kind are held', async () => {
    // mNew holds two provider_raw events plus one `tool` event. A {kinds:
    // ['provider_raw'], limit: 3} query is NOT satisfied by mNew alone, so mOld
    // must still be read and its newest raw event returned. Closing the bound
    // on fewer accepted events, or on the wrong kind, would silently drop it.
    AppStore.saveChat({
      appChatId: 'mixed',
      scope: 'workspace',
      chatKind: 'single',
      provider: 'gemini',
      title: 'M',
      workspaceId: 'ws',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [
        { runId: 'mOld', provider: 'gemini', startedAt: '2026-01-01T00:00:01.000Z', status: 'success' },
        { runId: 'mNew', provider: 'gemini', startedAt: '2026-01-01T00:00:02.000Z', status: 'success' }
      ]
    } as never)
    const ev = (runId: string, ms: number, kind = 'provider_raw'): void => {
      AppStore.appendRunEvent({
        runId,
        chatId: 'mixed',
        provider: 'gemini',
        kind,
        phase: kind === 'provider_raw' ? 'raw' : 'artifact',
        source: 'provider',
        payload: { data: 'x\n' },
        timestamp: new Date(ms).toISOString()
      } as never)
    }
    ev('mOld', 1000)
    ev('mOld', 1001)
    ev('mOld', 1002)
    ev('mNew', 2000)
    ev('mNew', 2001, 'tool')
    ev('mNew', 2002)

    const bounded = await AppStore.getRunEventsAsync({
      chatId: 'mixed',
      kinds: ['provider_raw'],
      limit: 3
    } as never)
    expect(bounded.map((e) => [e.runId, new Date(e.timestamp).getTime()])).toEqual([
      ['mOld', 1002],
      ['mNew', 2000],
      ['mNew', 2002]
    ])
  })

  it('refuses appends into a prepared (uncommitted) deletion scope with tombstone semantics', () => {
    AppStore.saveChat({
      appChatId: 'chat-frozen',
      scope: 'workspace',
      chatKind: 'single',
      provider: 'codex',
      title: 'Frozen',
      workspaceId: 'ws-frozen',
      workspacePath: '/repo/ws-frozen',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [{ runId: 'run-frozen', startedAt: '2026-07-21T00:00:00.000Z' }]
    } as never)
    const prepared = AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: 'chat-frozen' })
    expect(prepared.runIds).toContain('run-frozen')

    // A cancel racer settling during quiescence must not write frozen-scope
    // bytes the run-events step would then have to re-erase.
    expect(() =>
      AppStore.appendRunEvent(
        {
          runId: 'run-frozen',
          kind: 'lifecycle',
          phase: 'status',
          source: 'main'
        } as never,
        { durability: 'strict' }
      )
    ).toThrow(HistoryDeletionMutationBlockedError)

    const soft = AppStore.appendRunEvent({
      runId: 'run-frozen',
      kind: 'lifecycle',
      phase: 'status',
      source: 'main'
    } as never)
    expect(soft.sequence).toBe(1)
    expect(fs.existsSync(join(userDataPath, 'run-events', 'run-frozen.jsonl'))).toBe(false)

    // Chat-scope matching also covers a run id that was not frozen at prepare.
    const softByChat = AppStore.appendRunEvent({
      runId: 'run-late-unfrozen',
      chatId: 'chat-frozen',
      kind: 'lifecycle',
      phase: 'status',
      source: 'main'
    } as never)
    expect(softByChat.sequence).toBe(1)
    expect(fs.existsSync(join(userDataPath, 'run-events', 'run-late-unfrozen.jsonl'))).toBe(false)

    // An out-of-scope run keeps appending normally while the intent is pending.
    const unrelated = AppStore.appendRunEvent({
      runId: 'run-unrelated',
      kind: 'lifecycle',
      phase: 'status',
      source: 'main'
    } as never)
    expect(unrelated.sequence).toBe(1)
    expect(fs.existsSync(join(userDataPath, 'run-events', 'run-unrelated.jsonl'))).toBe(true)
  })
})
