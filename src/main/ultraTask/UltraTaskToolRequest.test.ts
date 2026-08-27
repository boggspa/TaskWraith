import { describe, expect, it } from 'vitest'
import {
  ULTRA_TASK_MAX_EFFECTIVE_WORKERS,
  resolveUltraTaskToolRequest
} from './UltraTaskToolRequest'

describe('resolveUltraTaskToolRequest', () => {
  it('inherits the provider and concrete model from the verified current run', () => {
    const result = resolveUltraTaskToolRequest(
      { task: 'Implement and verify the requested change.' },
      {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        allowedProviders: ['codex', 'claude']
      }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'max',
        returnResult: true,
        requestedMaxWorkers: 3,
        effectiveMaxWorkers: 3,
        scoutCount: 3,
        maxWorkersClamped: false,
        approvalPreviewWorkers: expect.any(Array)
      }
    })
    if (!result.ok) return
    expect(result.value.approvalPreviewWorkers).toHaveLength(6)
    expect(result.value.approvalPreviewWorkers.map((worker) => worker.role)).toEqual([
      'scout',
      'scout',
      'scout',
      'worker',
      'reviewer',
      'worker'
    ])
    expect(result.value.approvalPreviewWorkers.every((worker) => worker.provider === 'codex')).toBe(
      true
    )
    expect(
      result.value.approvalPreviewWorkers.every((worker) => worker.model === 'gpt-5.6-luna')
    ).toBe(true)
    expect(
      result.value.approvalPreviewWorkers.every((worker) => worker.reasoningEffort === 'max')
    ).toBe(true)
  })

  it('requires an explicit cross-provider model and returns concrete choices', () => {
    const result = resolveUltraTaskToolRequest(
      { task: 'Investigate this issue.', provider: 'claude' },
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        allowedProviders: ['codex', 'claude']
      }
    )

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/will not silently select.*default/i),
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-sonnet-5', ultraTaskSupported: true })
      ])
    })
  })

  it('requires a concrete active model instead of guessing from a legacy sentinel', () => {
    for (const model of [undefined, null, 'cli-default', 'default', 'custom'] as const) {
      expect(
        resolveUltraTaskToolRequest({ task: 'Do work.' }, { provider: 'codex', model })
      ).toMatchObject({
        ok: false,
        message: expect.stringMatching(/active run has no concrete model/i),
        models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.5' })])
      })
    }
  })

  it('rejects explicit legacy model sentinels', () => {
    for (const model of ['cli-default', 'default', 'custom'] as const) {
      expect(
        resolveUltraTaskToolRequest(
          { task: 'Do work.', model },
          { provider: 'codex', model: 'gpt-5.6-luna' }
        )
      ).toMatchObject({
        ok: false,
        message: expect.stringMatching(/concrete model id.*available concrete models/i),
        models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.5' })])
      })
    }
  })

  it('uses the provider normalizer for an explicit reasoning override', () => {
    const result = resolveUltraTaskToolRequest(
      {
        task: 'Review the implementation strategy.',
        provider: 'mistral',
        model: 'devstral-small',
        reasoningEffort: 'ultracode'
      },
      {
        provider: 'mistral',
        model: 'devstral-small',
        allowedProviders: ['mistral']
      }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        reasoningEffort: 'max'
      }
    })
    if (!result.ok) return
    expect(result.value.approvalPreviewWorkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'mistral',
          model: 'devstral-small',
          reasoningEffort: 'max'
        })
      ])
    )
  })

  it('omits an irrelevant effort axis without dropping UltraTask orchestration', () => {
    const result = resolveUltraTaskToolRequest(
      {
        task: 'Inspect the repository.',
        provider: 'grok',
        model: 'grok-composer-2.5-fast'
      },
      {
        provider: 'grok',
        model: 'grok-composer-2.5-fast',
        allowedProviders: ['grok']
      }
    )

    expect(result).toMatchObject({ ok: true, value: { provider: 'grok' } })
    if (!result.ok) return
    expect(result.value.reasoningEffort).toBeUndefined()
    expect(
      result.value.approvalPreviewWorkers.every((worker) => worker.reasoningEffort === undefined)
    ).toBe(true)
  })

  it.each([
    ['codex', 'gpt-5.5', 'xhigh'],
    ['claude', 'claude-sonnet-5', 'max'],
    ['kimi', 'kimi-k2.7-code', 'on'],
    ['kimi', 'kimi-k3', 'max'],
    ['kimi', 'kimi-k3-256k', 'max'],
    ['grok', 'grok-4.5', 'high'],
    ['mistral', 'devstral-small', 'max'],
    ['pi', 'deepseek/deepseek-v4-flash', 'max'],
    ['muse', 'muse-spark-1.2', 'ultra'],
    ['antigravity', 'gemini-3.6-flash-medium', 'high'],
    ['ollama', 'qwen3.5:9b', 'on']
  ] as const)(
    'maps automatic UltraTask reasoning to the %s/%s ceiling',
    (provider, model, expectedEffort) => {
      const result = resolveUltraTaskToolRequest(
        { task: 'Perform the UltraTask.' },
        { provider, model, allowedProviders: [provider] }
      )

      expect(result).toMatchObject({
        ok: true,
        value: {
          provider,
          model,
          reasoningEffort: expectedEffort
        }
      })
    }
  )

  it('caps durable scout stages at six and reports the clamp', () => {
    const result = resolveUltraTaskToolRequest(
      { task: 'Handle a large task.', maxWorkers: 64 },
      { provider: 'codex', model: 'gpt-5.5' }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        requestedMaxWorkers: 64,
        effectiveMaxWorkers: ULTRA_TASK_MAX_EFFECTIVE_WORKERS,
        scoutCount: ULTRA_TASK_MAX_EFFECTIVE_WORKERS,
        maxWorkersClamped: true,
        notice: expect.stringMatching(/capped at 6.*scout stages/i)
      }
    })
    if (!result.ok) return
    expect(
      result.value.approvalPreviewWorkers.filter((worker) => worker.role === 'scout')
    ).toHaveLength(ULTRA_TASK_MAX_EFFECTIVE_WORKERS)
  })

  it('uses maxWorkers as the durable scout-stage count', () => {
    const result = resolveUltraTaskToolRequest(
      { task: 'Handle a bounded task.', maxWorkers: 2 },
      { provider: 'codex', model: 'gpt-5.5' }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        effectiveMaxWorkers: 2,
        scoutCount: 2
      }
    })
    if (!result.ok) return
    expect(result.value.approvalPreviewWorkers.map((worker) => worker.role)).toEqual([
      'scout',
      'scout',
      'worker',
      'reviewer',
      'worker'
    ])
  })

  it('rejects reduced-DAG flags instead of silently ignoring them', () => {
    for (const args of [
      { task: 'Implement a parser.', enableFanout: false },
      { task: 'Implement a parser.', enableReview: false }
    ]) {
      expect(
        resolveUltraTaskToolRequest(args, { provider: 'codex', model: 'gpt-5.5' })
      ).toMatchObject({ ok: false, message: expect.stringMatching(/staged UltraTask graph/i) })
    }
  })

  it('fails closed on unsupported, unconfigured, or malformed provider/model controls', () => {
    expect(
      resolveUltraTaskToolRequest(
        { task: 'Do work.', provider: 'claude' },
        { provider: 'codex', model: 'gpt-5.5', allowedProviders: ['codex'] }
      )
    ).toMatchObject({ ok: false, message: expect.stringMatching(/not configured/i) })
    expect(
      resolveUltraTaskToolRequest(
        { task: 'Do work.', provider: 'gemini' },
        { provider: 'codex', model: 'gpt-5.5' }
      )
    ).toMatchObject({ ok: false, message: expect.stringMatching(/not live-selectable/i) })
    expect(
      resolveUltraTaskToolRequest(
        { task: 'Do work.', model: ' '.repeat(2) },
        { provider: 'codex', model: 'gpt-5.5' }
      )
    ).toMatchObject({ ok: false, message: expect.stringMatching(/model must be a non-empty/i) })
    expect(
      resolveUltraTaskToolRequest(
        { task: 'Do work.', provider: 'claude', model: 'claude-haiku-4-5' },
        { provider: 'claude', model: 'claude-haiku-4-5' }
      )
    ).toMatchObject({ ok: false, message: expect.stringMatching(/does not support UltraTask/i) })
  })

  it('rejects controls the underlying always-returning wave cannot honor', () => {
    for (const args of [
      { task: 'Do work.', returnResult: false },
      { task: 'Do work.', returnResult: 'yes' },
      { task: 'Do work.', reasoningEffort: 'warp' },
      { task: 'Do work.', reasoningEffort: 'off' },
      { task: 'Do work.', maxWorkers: 1 },
      { task: 'Do work.', enableReview: 'yes' }
    ]) {
      expect(
        resolveUltraTaskToolRequest(args, { provider: 'codex', model: 'gpt-5.5' })
      ).toMatchObject({ ok: false })
    }
  })
})
