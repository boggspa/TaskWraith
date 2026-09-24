import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AppStoreHostAuthority } from '../host-runtime/AppStoreHostAuthority'
import { projectHostProfileDomainSnapshot } from '../host-runtime/HostProfileDomainProjection'
import {
  HostProfileDomainStore,
  type HostProfileRun,
  type HostProfileThread
} from '../host-runtime/HostProfileDomainStore'
import { HostRuntimeBootstrap } from '../host-runtime/HostRuntimeBootstrap'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostHealthProjection
} from '../shared/hostProtocol'
import { hostCatalogueSummaries, projectHostCatalogueThread } from './ThreadCatalogueHostMirror'
import { ThreadCatalogueHostRunWindow } from './ThreadCatalogueHostRunWindow'

const CHAT_ID = 'chat-windowed'
const RUN_COUNT = 40
const NOW = '2026-09-24T12:49:01.449Z'
const ACTOR: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}
const HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}

const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

function windowedRuns(): HostProfileRun[] {
  return Array.from({ length: RUN_COUNT }, (_, index) => ({
    runId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    provider: 'codex',
    status: 'success',
    startedAt: new Date(Date.parse(NOW) - (RUN_COUNT - index) * 60_000).toISOString(),
    endedAt: new Date(Date.parse(NOW) - (RUN_COUNT - index) * 60_000 + 30_000).toISOString()
  }))
}

/**
 * The Host's catalogue mirror as the run window sees it: the persist's
 * publication observes the new source witness at once, while the history
 * index still serves the previous source's run rows.
 */
function catalogueHarness(runs: readonly HostProfileRun[]) {
  let revision = 1
  let witness = 'witness-1'
  const indexedWitness = 'witness-1'
  let listener: ((row: object | null, chatId: string) => void) | null = null
  const thread = (): HostProfileThread =>
    ({
      appChatId: CHAT_ID,
      scope: 'global',
      title: 'Windowed chat',
      provider: 'codex',
      chatKind: 'single',
      archived: false,
      createdAt: 1,
      updatedAt: revision * 10,
      persistenceRevision: revision,
      messages: [],
      runs
    }) as unknown as HostProfileThread
  const mirror = {
    complete: true,
    port: {
      async query(query: { method: string }) {
        if (query.method === 'open') {
          return { leaseId: 'lease-1', entry: { snapshot: false, projection: {} } }
        }
        if (query.method === 'release') return true
        if (query.method === 'host-runs') {
          return {
            entries: runs.map((run) => ({ chatId: CHAT_ID, sourceWitness: indexedWitness, run })),
            total: runs.length,
            next: null
          }
        }
        throw new Error(`unexpected query ${query.method}`)
      }
    },
    subscribe(next: (row: object | null, chatId: string) => void) {
      listener = next
      return () => {
        listener = null
      }
    },
    sourceWitnessFor: (chatId: string) => (chatId === CHAT_ID ? witness : undefined),
    projections: () => [projectHostCatalogueThread(thread())]
  } as unknown as ThreadCatalogueMirror
  return {
    mirror,
    persist() {
      revision += 1
      witness = `witness-${revision}`
      listener?.({}, CHAT_ID)
    }
  }
}

describe('Host run window across a thread-record persist', () => {
  it('publishes no run tombstones when the persisted chat’s runs are windowed', async () => {
    const runs = windowedRuns()
    const catalogue = catalogueHarness(runs)
    const window = new ThreadCatalogueHostRunWindow(catalogue.mirror, () => {})
    const store = new HostProfileDomainStore({
      profilePath: temporaryDirectory('host-run-window-profile-'),
      authority: { assertProfileAuthority: () => {} },
      threadSummarySource: () => hostCatalogueSummaries(catalogue.mirror),
      runSummarySource: () => window.snapshot()
    })
    const runtime = new HostRuntimeBootstrap({
      hostDataDir: temporaryDirectory('host-run-window-data-'),
      delta: { now: () => NOW },
      receipts: { now: () => NOW }
    })
    const authority = new AppStoreHostAuthority({
      mode: 'in-process-migration',
      activationPermit: { hostOwnedStateMayHaveAdvanced: false },
      now: () => NOW,
      ports: {
        runtime,
        snapshotDonor: () => ({
          ...projectHostProfileDomainSnapshot({ store, health: HEALTH, providers: [] }),
          approvals: [],
          questions: []
        }),
        authorityEvaluator: () => ({ decision: 'allowed', reason: 'test allow' }),
        commandExecutor: () => {
          catalogue.persist()
          return { status: 'succeeded', resultSummary: 'thread_record_persisted' }
        },
        healthProvider: () => HEALTH,
        onShutdown: () => {}
      }
    })
    try {
      await expect(window.refreshFor(CHAT_ID, runs[0]!.runId)).resolves.toBe(true)

      const result = await authority.command(
        {
          actor: ACTOR,
          client: { clientId: ACTOR.clientId, clientClass: 'desktop', clientVersion: 'test' }
        },
        {
          type: 'host.command',
          protocolVersion: HOST_PROTOCOL_VERSION,
          commandId: 'persist-windowed-chat',
          idempotencyKey: 'persist-windowed-chat-key',
          actor: ACTOR,
          name: 'thread.record.persist',
          target: { threadId: CHAT_ID },
          arguments: {
            transferId: '11111111-1111-4111-8111-111111111111',
            sha256: 'a'.repeat(64),
            byteLength: 1,
            expectedRevision: 1
          },
          issuedAt: NOW
        }
      )

      expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      const journalled = runtime.deltaStore.since({ generation: 1, cursor: 0 })
      if (journalled.kind !== 'deltas') throw new Error(`unexpected ${journalled.kind}`)
      expect(journalled.deltas).toContainEqual(
        expect.objectContaining({ kind: 'upsert', family: 'thread', entityId: CHAT_ID })
      )
      // Capture-01: one save tombstoned the chat's 1,400 windowed runs.
      expect(journalled.deltas.filter((delta) => delta.family === 'run')).toEqual([])
      expect(window.snapshot()).toMatchObject({ total: RUN_COUNT, complete: false })
      expect(window.snapshot().entries).toHaveLength(RUN_COUNT)
    } finally {
      window.dispose()
    }
  })
})
