import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { runT2BaselineCli } = require('./runT2Baseline.cjs')
const { runLiveRoundSequence } = require('./liveRounds.cjs')
describe('X6 live capture controls', () => {
  it('rejects controls on replay and invalid repetition indices before I/O', async () => {
    await expect(runT2BaselineCli(['--workload=dual_run', '--live-repetitions=1'])).rejects.toThrow(
      'require --live-lanes'
    )
    await expect(runT2BaselineCli(['--live-lanes', '--live-repetitions=2'])).rejects.toThrow(
      '1 or 3'
    )
    await expect(
      runT2BaselineCli(['--live-lanes', '--live-repetitions=1', '--live-repetition-index=3'])
    ).rejects.toThrow('0..2')
  })
  it('saves every heavy chat before sending measured smoke and stops on unproven save', async () => {
    const ids: string[] = []
    const runRound = async (options: any) => {
      ids.push(options.chatId)
      return {
        outcome: 'settled',
        roundStatus: 'completed',
        turnsFinished: 1,
        roundId: `r-${ids.length}`,
        d1: { delta: { normalSaves: 1, deferredAppends: 1, unsyncedAppends: 0 } }
      }
    }
    const result = await runLiveRoundSequence({
      heavyChatIds: ['h1', 'h2'],
      roundOptions: { chatId: 'light' },
      barrierDurability: 'off',
      runRound
    })
    expect(ids).toEqual(['h1', 'h2', 'light', 'light'])
    expect(result.verdict.ok).toBe(true)
    const refused = await runLiveRoundSequence({
      heavyChatIds: ['h'],
      roundOptions: { chatId: 'light' },
      barrierDurability: 'off',
      runRound: async () => ({ outcome: 'settled', roundStatus: 'completed', turnsFinished: 1 })
    })
    expect(refused.verdict.ok).toBe(false)
  })
})
