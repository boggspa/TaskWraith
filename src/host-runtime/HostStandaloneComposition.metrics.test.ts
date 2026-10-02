import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HOST_PROTOCOL_VERSION } from '../shared/hostProtocol'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { createHostPerfInstrumentation } from './HostPerfSnapshot'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition
} from './HostStandaloneComposition'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import { modelHostThreadRecordFile } from './HostThreadRecordModel'
import { createHostThreadRecordCommitPort } from './HostThreadRecordTransaction'
import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'

describe('composition production metrics wiring', () => {
  it('reports the actual transaction gate, store-fed index and injected recorder', async () => {
    const profilePath = mkdtempSync(join(tmpdir(), 'composition-metrics-'))
    const runtimePath = join(profilePath, 'host-data')
    let composition: HostStandaloneComposition | undefined
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority: () => undefined },
      onThreadRecordWritten: (id, kind, thread) => composition?.markThreadRecord?.(id, kind, thread)
    })
    const records = createHostThreadRecordCommitPort({
      store,
      profilePath,
      beginTicket: async () => ({ finish: () => undefined, fail: () => undefined })
    })
    const instrumentation = createHostPerfInstrumentation()
    try {
      composition = createHostStandaloneComposition({
        runtimePath,
        profilePath,
        lease: { assertHeld: () => undefined },
        host: { hostId: 'metrics-host', hostVersion: '1' },
        hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
        bootEpochFactory: () => 'a'.repeat(64),
        snapshotDonor: () => ({
          health: {
            hostStatus: 'ok',
            connectionPhase: 'live',
            supervised: false,
            freshness: 'live'
          },
          workspaces: [],
          threads: [],
          runs: [],
          missions: [],
          rounds: [],
          participants: [],
          providers: [],
          questions: [],
          approvals: [],
          schedules: [],
          usage: { availability: 'unavailable' },
          artifacts: [],
          warnings: []
        }),
        authorityEvaluator: () => ({ decision: 'allowed' }),
        commandExecutor: () => ({ status: 'succeeded' }),
        healthProvider: () => ({
          hostStatus: 'ok',
          connectionPhase: 'live',
          supervised: false,
          freshness: 'live'
        }),
        perf: { instrumentation },
        threadRecordTransaction: {
          profilePath,
          records,
          prepare: async (input) => prepareHostThreadRecord(input),
          model: async (input) => modelHostThreadRecordFile(input)
        }
      })
      expect(composition.perf.spans).toBe(instrumentation.spans)
      instrumentation.spans.record({
        chatId: 'metrics-chat',
        kind: 'durable_commit',
        resource: 'host_chain',
        startedAt: 0,
        durationMs: 1
      })
      const actor = { actorId: 'actor', clientId: 'client', clientClass: 'desktop' as const }
      const descriptor = publishHostThreadRecordTransfer({
        profilePath,
        transferId: 'metrics-transfer',
        record: {
          appChatId: 'metrics-chat',
          scope: 'global',
          title: 'Metrics',
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          persistenceRevision: 1,
          messages: [],
          runs: []
        }
      })
      const result = await composition.authority.command(
        { actor, client: { clientId: 'client', clientClass: 'desktop', clientVersion: '1' } },
        {
          type: 'host.command',
          protocolVersion: HOST_PROTOCOL_VERSION,
          commandId: 'metrics-command',
          idempotencyKey: 'metrics-key',
          actor,
          name: 'thread.record.persist',
          target: { threadId: 'metrics-chat' },
          arguments: { ...descriptor, expectedRevision: 0 },
          issuedAt: new Date().toISOString()
        }
      )
      expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      await vi.waitFor(() =>
        expect(composition!.perf.snapshot().sections.publicWindowIndex).toMatchObject({
          threads: 1
        })
      )
      const sections = composition.perf.snapshot().sections
      expect(sections.commitGate).toMatchObject({
        modes: { committer: { entered: expect.any(Number), holdMs: { count: expect.any(Number) } } }
      })
      expect(
        (sections.commitGate as { modes: { committer: { entered: number } } }).modes.committer
          .entered
      ).toBeGreaterThan(0)
      expect(sections.publicWindowIndex).toMatchObject({ threads: 1 })
      store.persistThreadRecord({
        threadId: 'other-chat',
        expectedRevision: 0,
        record: {
          appChatId: 'other-chat',
          scope: 'global',
          title: 'Other',
          archived: false,
          createdAt: 1,
          updatedAt: 3,
          messages: [],
          runs: []
        }
      })
      await vi.waitFor(() =>
        expect(composition!.perf.snapshot().sections.publicWindowIndex).toMatchObject({
          threads: 2
        })
      )
      expect(composition.perf.snapshot().sections.publicWindowFeeder).toMatchObject({
        eager: expect.any(Number),
        drained: expect.any(Number)
      })
      expect(composition.perf.snapshot().sections.publicWindowIndex).toMatchObject({ threads: 2 })
      expect(
        (composition.perf.snapshot().sections.publicWindowFeeder as { eager: number }).eager
      ).toBeGreaterThan(0)
      expect(composition.perf.snapshot().sections.workSpans).toMatchObject({
        process: 'host',
        recorded: expect.any(Number)
      })
      expect(instrumentation.spans.snapshot().recorded).toBeGreaterThan(0)
    } finally {
      await composition?.shutdown()
      rmSync(profilePath, { recursive: true, force: true })
    }
  })
})
