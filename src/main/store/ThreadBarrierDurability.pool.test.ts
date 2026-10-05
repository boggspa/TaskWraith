import { describe, expect, it } from 'vitest'
import { createThreadBarrierDurability } from './ThreadBarrierDurability'
import type { CheckpointPreparationSource } from './CheckpointPreparationProtocol'

const MiB = 1024 * 1024
const source = (bytes: number): CheckpointPreparationSource => ({
  chatId: 'pool-test',
  revision: 1,
  savedAt: '2026-10-05T00:00:00Z',
  checkpoint: {
    path: '/never-opened/checkpoint.json',
    identity: { dev: '1', ino: '1', size: bytes - 1, mtimeNs: '1', ctimeNs: '1' }
  },
  journal: {
    path: '/never-opened/journal.jsonl',
    identity: { dev: '1', ino: '2', size: 1, mtimeNs: '1', ctimeNs: '1' }
  }
})

describe('the barrier layer checkpoint pool', () => {
  it('supports the larger bounded source only in its own configured pool', () => {
    const layer = createThreadBarrierDurability()
    try {
      expect(layer.journal.checkpointPreparation.admits!(source(80_431_677))).toBe(true)
      expect(layer.journal.checkpointPreparation.admits!(source(96 * MiB))).toBe(true)
      expect(layer.journal.checkpointPreparation.admits!(source(96 * MiB + 1))).toBe(false)
    } finally {
      layer.dispose()
    }
  })
})
