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

  it('offers Max on both Wonder models and regular Muse Spark 1.3', () => {
    expect(MUSE_MAX_REASONING_MODEL_IDS).toEqual([
      'muse-wonder-1.0',
      'muse-wonder-full-1.0',
      'muse-spark-1.3'
    ])
    for (const modelId of ['muse-wonder-1.0', 'muse-wonder-full-1.0']) {
      expect(museModelSupportsMaxReasoning(` ${modelId.toUpperCase()} `)).toBe(true)
      expect(museReasoningEffortsForModel(modelId)).toContain('max')
    }
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
      'muse-wonder-1.0',
      'muse-wonder-full-1.0',
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor'
    ]) {
      expect(museReasoningEffortsForModel(modelId)).toContain('ultra')
    }
  })
})
