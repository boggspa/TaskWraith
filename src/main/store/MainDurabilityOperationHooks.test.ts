import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChatPreparationLane } from './ChatPreparationLane'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import { MainDurabilityResiduals } from './MainDurabilityResiduals'

describe('actual operation residual hooks', () => {
  it('records actual deadline refusals and contains diagnostic failures', () => {
    const collector = new MainDurabilityResiduals('epoch')
    const observer = collector.enroll(['preparationRefusals'])
    const lane = new ChatPreparationLane((counter) => {
      observer(counter)
      throw new Error('diagnostic')
    })
    lane.enqueue({ chatId: 'chat', revision: 1, generation: 1, purpose: 'publication' }, 0)
    lane.advance(0)
    expect(lane.advance(300)).toContainEqual({ type: 'refused', id: 1, reason: 'deadline' })
    expect(collector.snapshot('window').counters.preparationRefusals).toBe(1)
    expect(lane.stats().refusals).toBe(1)
  })
  it('counts strict legacy syscall attempts including failures without altering append errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-hook-'))
    fs.mkdirSync(path.join(root, 'events'))
    const collector = new MainDurabilityResiduals('epoch')
    const observer = collector.enroll(['strictRunEventFsyncs'])
    const writer = new RunEventLedgerWriter({
      runEventsDir: path.join(root, 'events'),
      runArtifactsDir: path.join(root, 'artifacts'),
      residualObserver: (counter) => {
        observer(counter)
        throw new Error('diagnostic')
      }
    })
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('actual disk error')
    })
    try {
      expect(() =>
        writer.append(
          {
            runId: 'run',
            kind: 'provider_raw',
            phase: 'raw',
            source: 'provider',
            payload: {},
            timestamp: new Date().toISOString()
          },
          { durability: 'strict' }
        )
      ).toThrow('actual disk error')
      expect(collector.snapshot('window').counters.strictRunEventFsyncs).toBe(1)
    } finally {
      sync.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
