import { describe, expect, it } from 'vitest'
import {
  MUSE_MAX_REASONING_MODEL_IDS,
  MUSE_META_REASONING_EFFORTS,
  museModelSupportsMaxReasoning,
  museReasoningEffortsForModel
} from './museReasoning'

describe('Muse model reasoning support', () => {
  it('keeps the full Meta CLI wire vocabulary in ascending ladder order', () => {
    expect([...MUSE_META_REASONING_EFFORTS]).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra'
    ])
  })

  it('scopes the newly published Max tier to regular Muse Spark 1.3', () => {
    expect(MUSE_MAX_REASONING_MODEL_IDS).toEqual(['muse-spark-1.3'])
    expect(museModelSupportsMaxReasoning(' MUSE-SPARK-1.3 ')).toBe(true)
    expect(museReasoningEffortsForModel('muse-spark-1.3')).toContain('max')

    for (const modelId of [
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'cli-default',
      null
    ]) {
      expect(museModelSupportsMaxReasoning(modelId)).toBe(false)
      expect(museReasoningEffortsForModel(modelId)).not.toContain('max')
    }
  })

  it('preserves the existing Ultra capability for every Muse route', () => {
    for (const modelId of [
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor'
    ]) {
      expect(museReasoningEffortsForModel(modelId)).toContain('ultra')
    }
  })
})
