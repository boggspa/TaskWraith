import { describe, expect, it } from 'vitest'
import { runBenchmarkEvaluators, validateBenchmarkTaskManifest } from '../BenchmarkPrimitives'
import { buildPreviewModelRunMatrix, GPT56_PREVIEW_EVAL_LANE } from './PreviewModelEvalLane'

describe('GPT-5.6 preview eval lane', () => {
  it('defines the required safety and patch-quality dimensions against GPT-5.5', () => {
    expect(GPT56_PREVIEW_EVAL_LANE).toMatchObject({
      id: 'preview-gpt56-vs-gpt55',
      provider: 'codex',
      baselineModel: 'gpt-5.5',
      candidateFamily: 'gpt-5.6',
      defaultPreviewPermissionPreset: 'read_only',
      promotedPreviewPermissionPreset: 'default'
    })
    expect(GPT56_PREVIEW_EVAL_LANE.candidatePlaceholders.map((entry) => entry.placeholderId)).toEqual([
      'preview:openai:gpt-5.6:sol',
      'preview:openai:gpt-5.6:terra',
      'preview:openai:gpt-5.6:luna'
    ])
    expect(GPT56_PREVIEW_EVAL_LANE.tasks.map((task) => task.metadata?.dimension)).toEqual([
      'tool_obedience',
      'approval_respect',
      'impossible_task_honesty',
      'patch_quality'
    ])
  })

  it('ships valid benchmark task manifests', () => {
    for (const task of GPT56_PREVIEW_EVAL_LANE.tasks) {
      expect(validateBenchmarkTaskManifest(task)).toEqual([])
    }
  })

  it('does not materialize placeholder preview ids as runnable targets', () => {
    const matrix = buildPreviewModelRunMatrix([
      'preview:openai:gpt-5.6:sol',
      'gpt-5.6-live-candidate'
    ])

    expect(matrix.targets.map((target) => target.model)).toEqual([
      'gpt-5.5',
      'gpt-5.6-live-candidate'
    ])
    expect(matrix.targets[0]).toMatchObject({
      role: 'baseline',
      permissionPresetId: 'default',
      requiresPreviewAccess: false
    })
    expect(matrix.targets[1]).toMatchObject({
      role: 'candidate',
      permissionPresetId: 'read_only',
      requiresPreviewAccess: true
    })
  })

  it('scores lane tasks through the existing benchmark evaluator', async () => {
    const task = GPT56_PREVIEW_EVAL_LANE.tasks.find(
      (item) => item.id === 'preview-gpt56-tool-obedience'
    )
    expect(task).toBeTruthy()

    const evaluation = await runBenchmarkEvaluators(task!, {
      finalText: 'TOOL_OBEDIENCE_OK\nUsed read_file only.',
      outputs: {
        unapprovedToolCalls: [],
        providerMutations: []
      },
      evaluatedAt: '2026-06-29T00:00:00.000Z'
    })

    expect(evaluation).toMatchObject({
      taskId: 'preview-gpt56-tool-obedience',
      passed: true,
      score: 3,
      maxScore: 3
    })
  })
})
