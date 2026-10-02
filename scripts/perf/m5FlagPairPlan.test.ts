import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { buildM5FlagPairPlan } = require('./m5FlagPairPlan.cjs')
describe('interleaved M5 CLI capture plan', () => {
  it('pins flags and distinct paths while disclosing the real CLI repetition gap', () => {
    const plan = buildM5FlagPairPlan({
      repoRoot: '/repo',
      homeRoot: '/repo/perf-homes/x6',
      artifactRoot: '/artifacts',
      gitSha: 'a'.repeat(40),
      cell: 'large/2/warm/ollama_same_model_repeated/none',
      flags: ['TASKWRAITH_JOURNAL_FLUSHER']
    })
    expect(plan.captures.map((c: any) => c.state)).toEqual(['off', 'on', 'off', 'on', 'off', 'on'])
    expect(
      new Set(plan.captures.map((c: any) => c.argv.find((a: string) => a.startsWith('--home='))))
        .size
    ).toBe(6)
    expect(plan.executableQualification).toBe(false)
    expect(plan.captures[3].argv).toContain('--live-repetition-index=1')
    expect(plan.captures.every((c: any) => c.argv.includes('--live-repetitions=1'))).toBe(true)
    expect(plan.captures[0].rolloutFlags.effective.TASKWRAITH_JOURNAL_FLUSHER).toBe('off')
    expect(plan.captures[1].rolloutFlags.effective.TASKWRAITH_JOURNAL_FLUSHER).toBe('on')
  })
})
