import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'

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

  it('persists provider stream artifacts when raw events are enabled', () => {
    AppStore.updateSettings({ storeRawEvents: true })

    const record = AppStore.appendRunEvent({
      runId: 'run-raw-on',
      provider: 'gemini',
      kind: 'provider_raw',
      phase: 'raw',
      source: 'provider',
      payload: { data: 'provider stream persisted\n' }
    })

    expect(record.artifacts).toHaveLength(1)
    expect(record.artifacts?.[0]).toMatchObject({
      kind: 'stdout',
      path: 'run-raw-on/stdout.log'
    })
    expect(
      fs.readFileSync(join(userDataPath, 'run-artifacts', 'run-raw-on', 'stdout.log'), 'utf8')
    ).toBe('provider stream persisted\n')
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
})
