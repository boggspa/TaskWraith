import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'
import { DurableMomentGate } from '../run/DurableMomentGate'
import {
  JOURNAL_CHECKPOINT_TRIGGERS,
  type JournalCheckpointCounts
} from './JournalCheckpointCounts'
import { createThreadBarrierDurability } from './ThreadBarrierDurability'
import { readThreadBarrierDurabilityPerf } from './ThreadBarrierDurabilityPerf'

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
  'threads',
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
      threads: null,
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
      checkpoints: counts,
      tornTailsTruncated: () => 0
    })

    expect(section).toMatchObject({ enabled: false, ignored: 'TASKWRAITH_JOURNAL_FLUSHER on' })
  })

  it("with the switch on, reports each part's whole snapshot, read when the section is", () => {
    const layer = createThreadBarrierDurability()
    const gate = new DurableMomentGate({ source: layer.tickets })
    layer.tickets.note('chat-1', 3, 'user_message', Promise.resolve())

    const section = readThreadBarrierDurabilityPerf({
      switches: { barrierDurability: true, barrierDurabilityIgnored: null },
      layer,
      gate,
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
      threads: parts.threads,
      checkpoints: counts(),
      tornTailsRepaired: 1
    })
    // The port this process built keeps its counters; the section carries all of them.
    expect(section.port).not.toBeNull()
    expect(section.tickets?.moments.user_message.noted).toBe(1)
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
