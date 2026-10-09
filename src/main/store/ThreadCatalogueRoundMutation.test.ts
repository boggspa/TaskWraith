import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadCatalogueDiskReader } from './ThreadCatalogueDiskReader'
import { prepareThreadCatalogueMutation } from './ThreadCatalogueMutation'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) fs.rmSync(path, { recursive: true, force: true })
})

describe('cross-process Ensemble round recovery', () => {
  it.each(['desktop-live', 'desktop-restarted'])('respects the caller identity %s', (caller) => {
    const profilePath = fs.mkdtempSync(join(tmpdir(), 'tw-round-recovery-'))
    paths.push(profilePath)
    fs.mkdirSync(join(profilePath, 'chats'))
    fs.writeFileSync(
      join(profilePath, 'chats', 'chat.json'),
      JSON.stringify({
        appChatId: 'chat',
        title: 'Handoff',
        scope: 'global',
        provider: 'claude',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages: [],
        runs: [
          {
            runId: 'run',
            provider: 'claude',
            status: 'success',
            startedAt: '2026-01-01T00:00:00Z',
            endedAt: '2026-01-01T00:01:00Z'
          }
        ],
        ensemble: {
          enabled: true,
          participants: [],
          activeRound: {
            roundId: 'round',
            status: 'running',
            participants: [
              { participantId: 'seat', provider: 'claude', status: 'answered', runId: 'run' }
            ],
            turnTransition: {
              phase: 'settling-provider',
              sourceParticipantId: 'seat',
              sourceRunId: 'run',
              runtimeInstanceId: 'desktop-live',
              startedAt: '2026-01-01T00:01:00Z'
            }
          }
        }
      })
    )
    const options = { profilePath, runtimeInstanceId: 'standalone-host', segmented: false }
    const sourceWitness = new ThreadCatalogueDiskReader(options).read('chat')!.source.witness
    const prepared = prepareThreadCatalogueMutation(options, {
      chatId: 'chat',
      sourceWitness,
      epoch: { global: 'g', chat: 'c' },
      heads: { desktop: null, host: null },
      mutation: {
        kind: 'settle-runs',
        nowIso: '2026-01-01T00:04:00Z',
        minAgeMs: 0,
        runtimeInstanceId: caller,
        runs: [{ runId: 'run' }]
      }
    })
    if (caller === 'desktop-live') expect(prepared).toBeNull()
    else expect(prepared?.checkedRuns).toEqual([{ runId: 'run' }])
  })
})
