import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'
import { DurableMomentGate } from '../run/DurableMomentGate'
import {
  JOURNAL_CHECKPOINT_TRIGGERS,
  type JournalCheckpointCounts
} from './JournalCheckpointCounts'
import { createThreadBarrierDurability } from './ThreadBarrierDurability'
import { readThreadBarrierDurabilityPerf } from './ThreadBarrierDurabilityPerf'
import type { ChatRecord } from './types'

function counts(): JournalCheckpointCounts {
  return Object.fromEntries(
    JOURNAL_CHECKPOINT_TRIGGERS.map((trigger, index) => [
      trigger,
      { count: index, bytes: index * 100, mainMs: index / 2 }
    ])
  ) as JournalCheckpointCounts
}

/** The section's fields, as the brief names them and the harness reads them. */
const FIELDS = [
  'enabled',
  'ignored',
  'debt',
  'port',
  'tickets',
  'gates',
  'starts',
  'threads',
  'staging',
  'usageLog',
  'runQueue',
  'checkpoints',
  'tornTailsRepaired'
]

describe('the threadBarrierDurability perf section', () => {
  it('with the switch off, has no layer to report, and still counts checkpoints and torn tails', () => {
    const checkpoints = counts()

    const section = readThreadBarrierDurabilityPerf({
      switches: { barrierDurability: false, barrierDurabilityIgnored: null },
      layer: null,
      gate: null,
      startGate: null,
      usage: { unsyncedSnapshot: () => null },
      runQueue: null,
      checkpoints: () => checkpoints,
      tornTailsTruncated: () => 2
    })

    expect(section).toEqual({
      enabled: false,
      ignored: null,
      debt: null,
      port: null,
      tickets: null,
      gates: null,
      starts: null,
      threads: null,
      staging: null,
      usageLog: null,
      runQueue: null,
      checkpoints,
      tornTailsRepaired: 2
    })
    expect(Object.keys(section)).toEqual(FIELDS)
  })

  it('says why the switch was set and not honoured', () => {
    const section = readThreadBarrierDurabilityPerf({
      switches: {
        barrierDurability: false,
        barrierDurabilityIgnored: 'TASKWRAITH_JOURNAL_FLUSHER on'
      },
      layer: null,
      gate: null,
      startGate: null,
      usage: { unsyncedSnapshot: () => null },
      runQueue: null,
      checkpoints: counts,
      tornTailsTruncated: () => 0
    })

    expect(section).toMatchObject({ enabled: false, ignored: 'TASKWRAITH_JOURNAL_FLUSHER on' })
  })

  it("with the switch on, reports each part's whole snapshot, read when the section is", () => {
    const committed = (): never => {
      throw new Error('No batch of tool detail is committed here')
    }
    const layer = createThreadBarrierDurability({
      detail: {
        runArtifactsDir: join(tmpdir(), 'owner-perf-staging-never-written'),
        appendRunEvent: committed,
        checkpointInput: committed,
        refuses: () => false
      }
    })
    const gate = new DurableMomentGate({ source: layer.tickets })
    const startGate = new DurableMomentGate({ source: layer.tickets })
    layer.tickets.note('chat-1', 3, 'user_message', Promise.resolve())
    // A queued start's barrier, counted apart from the waits the user sits in.
    void startGate.bound(Promise.resolve())
    // A row staged and never committed: counted, and nothing is written.
    layer.detailBatch({ appChatId: 'chat-1' } as ChatRecord)!.stage('run-1', {
      id: 'activity-1',
      toolName: 'run_shell_command',
      displayName: 'Ran command',
      category: 'shell',
      status: 'success',
      endedAt: '2026-10-05T00:00:00.000Z',
      rawResultEvent: { output: 'Detail of the command' }
    })

    // The usage log's counters, read when the section is.
    const usageLog = {
      appends: 4,
      spills: 1,
      background: {
        owed: { files: 1, directories: 0 },
        rounds: 2,
        failedRounds: 0,
        syncs: { files: 2, directories: 1 },
        quitRounds: 0,
        quitUnpaid: 0
      },
      compactions: { started: 1, completed: 1, stopped: 0, failed: 0 }
    }
    // The run queue's counters, and the gate a person's change waited at.
    const runQueueFile = {
      changes: 7,
      writes: 2,
      coalesced: 5,
      failed: 0,
      superseded: 0,
      inlineWrites: 1,
      syncs: { files: 2, directories: 2 },
      writing: false,
      unwrittenChanges: 0,
      quitUnwritten: 0
    }
    const userGate = new DurableMomentGate({
      source: { holds: () => false, awaitChat: () => Promise.resolve() }
    })
    void userGate.bound(Promise.resolve())
    const section = readThreadBarrierDurabilityPerf({
      switches: { barrierDurability: true, barrierDurabilityIgnored: null },
      layer,
      gate,
      startGate,
      usage: { unsyncedSnapshot: () => usageLog },
      runQueue: { file: { snapshot: () => runQueueFile }, userGate, startGate },
      checkpoints: counts,
      tornTailsTruncated: () => 1
    })

    const parts = layer.snapshot()
    expect(Object.keys(section)).toEqual(FIELDS)
    expect(section).toEqual({
      enabled: true,
      ignored: null,
      debt: parts.debt,
      port: parts.port,
      tickets: parts.tickets,
      gates: gate.snapshot(),
      starts: startGate.snapshot(),
      threads: parts.threads,
      staging: parts.staging,
      usageLog,
      runQueue: {
        ...runQueueFile,
        userWaits: userGate.snapshot(),
        startWaits: startGate.snapshot()
      },
      checkpoints: counts(),
      tornTailsRepaired: 1
    })
    // The port this process built keeps its counters; the section carries all of them.
    expect(section.port).not.toBeNull()
    expect(section.tickets?.moments.user_message.noted).toBe(1)
    expect(section.staging?.rows.staged).toBe(1)
    expect([section.gates?.waits, section.starts?.waits]).toEqual([0, 1])
    expect(section.runQueue?.userWaits.waits).toBe(1)
  })
})

describe('the section in main', () => {
  const probe = new MainSourceProbe('index.ts', new URL('../index.ts', import.meta.url))

  it('is read from the store on every poll of the perf snapshot', () => {
    const instrumentation = probe.callsTo(probe.source, 'createMainPerfInstrumentation')
    expect(instrumentation).toHaveLength(1)
    const sections = probe.propText(instrumentation[0], 0, 'sections')
    expect(sections).not.toBeNull()
    expect(sections).toContain(
      'threadBarrierDurability: () => AppStore.getThreadBarrierDurabilityPerf()'
    )
  })
})
