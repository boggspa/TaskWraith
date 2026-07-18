import { describe, expect, it } from 'vitest'

import type {
  ExecutionArtifactRef,
  ExecutionStepResult,
  OutputStep,
  StepAttempt
} from './ExecutionGraphModel'
import { planExecutionArtifactPromotion } from './ExecutionArtifactPromotion'

const outputStep: OutputStep = {
  id: 'deliver',
  kind: 'output',
  title: 'Deliver',
  objective: 'Collect reviewed outputs.',
  effect: 'read_only',
  retry: { maxAttempts: 1 },
  output: { label: 'Research output', projectReference: 'propose' }
}

const outputAttempt: StepAttempt = {
  id: 'attempt-output',
  activationId: 'activation-output',
  stepId: outputStep.id,
  ordinal: 1,
  state: 'succeeded',
  createdAt: '2026-07-18T10:00:00.000Z',
  updatedAt: '2026-07-18T10:01:00.000Z',
  completedAt: '2026-07-18T10:01:00.000Z'
}

function artifact(id: string, uri: string): ExecutionArtifactRef {
  return {
    schemaVersion: 1,
    id,
    kind: 'file',
    uri,
    createdByAttemptId: 'attempt-source',
    trust: 'untrusted_agent_output'
  }
}

function providerAttempt(
  artifacts: readonly ExecutionArtifactRef[],
  overrides: Partial<StepAttempt> = {},
  resultOverrides: Partial<ExecutionStepResult> = {}
): StepAttempt {
  return {
    id: 'attempt-source',
    activationId: 'activation-source',
    stepId: 'research',
    ordinal: 1,
    state: 'succeeded',
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:30:00.000Z',
    completedAt: '2026-07-18T09:30:00.000Z',
    providerRunRef: 'provider-run-1',
    result: {
      schemaVersion: 1,
      artifactRefs: artifacts,
      trust: 'untrusted_agent_output',
      providerRunRef: 'provider-run-1',
      threadRef: 'chat-root',
      ...resultOverrides
    },
    ...overrides
  }
}

function plan(attempts: readonly StepAttempt[]) {
  return planExecutionArtifactPromotion({
    executionId: 'execution-1',
    projectId: 'project-1',
    rootChatId: 'chat-root',
    outputStep,
    outputAttempt,
    upstreamAttempts: attempts
  })
}

describe('Execution artifact promotion planner', () => {
  it('emits review-only intents for provider-backed file, folder, and http(s) artifacts', () => {
    const result = plan([
      providerAttempt([
        artifact('file-a', '/workspace/reports/findings.md'),
        artifact('folder-a', '/workspace/reports/'),
        artifact('url-a', 'https://example.com/report?id=public'),
        artifact('file-url-a', 'file:///workspace/exports/table.csv')
      ])
    ])

    expect(result.diagnostics).toEqual([])
    expect(result.intents.map((intent) => intent.candidate)).toEqual([
      { kind: 'file', locator: '/workspace/reports/findings.md', title: 'findings.md' },
      { kind: 'folder', locator: '/workspace/reports/', title: 'reports' },
      {
        kind: 'url',
        locator: 'https://example.com/report?id=public',
        title: 'report'
      },
      { kind: 'file', locator: '/workspace/exports/table.csv', title: 'table.csv' }
    ])
    expect(result.intents[0]).toMatchObject({
      disposition: 'review_required',
      projectId: 'project-1',
      evidence: {
        executionId: 'execution-1',
        providerRunRef: 'provider-run-1',
        threadRef: 'chat-root',
        rootChatId: 'chat-root'
      }
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.intents[0].candidate)).toBe(true)
  })

  it('marks deterministic and unbound pseudo-artifacts explicitly ineligible', () => {
    const deterministic = providerAttempt(
      [artifact('deterministic-a', '/workspace/check.json')],
      {},
      {
        trust: 'deterministic',
        providerRunRef: undefined
      }
    )
    const noRealRun = providerAttempt(
      [artifact('unbound-a', '/workspace/draft.md')],
      {
        providerRunRef: undefined
      },
      {
        providerRunRef: undefined
      }
    )
    const wrongThread = providerAttempt(
      [artifact('foreign-a', '/workspace/foreign.md')],
      {},
      {
        threadRef: 'chat-elsewhere'
      }
    )

    const result = plan([deterministic, noRealRun, wrongThread])

    expect(result.intents).toEqual([])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'deterministic_result_ineligible',
      'provider_run_reference_missing',
      'thread_identity_mismatch'
    ])

    const deterministicArtifact = {
      ...artifact('deterministic-artifact', '/workspace/generated-check.json'),
      trust: 'deterministic' as const
    }
    expect(plan([providerAttempt([deterministicArtifact])])).toMatchObject({
      intents: [],
      diagnostics: [{ code: 'deterministic_artifact_ineligible' }]
    })
  })

  it('never persists or echoes credential-bearing locators', () => {
    const secret = 'do-not-persist-this-token'
    const result = plan([
      providerAttempt([
        artifact('credential-url', `https://user:${secret}@example.com/report`),
        artifact('signed-url', `https://example.com/report?access_token=${secret}`),
        artifact('fragment-url', `https://example.com/report#${secret}`)
      ])
    ])

    expect(result.intents).toEqual([])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'artifact_locator_sensitive',
      'artifact_locator_sensitive',
      'artifact_locator_sensitive'
    ])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('access_token')
  })

  it('does not mutate a Project reference catalogue or return a direct add operation', () => {
    const catalogue = Object.freeze([
      Object.freeze({ id: 'existing', projectId: 'project-1', locator: '/workspace/existing.md' })
    ])
    const snapshot = JSON.stringify(catalogue)
    const result = plan([providerAttempt([artifact('new-a', '/workspace/new.md')])])

    expect(JSON.stringify(catalogue)).toBe(snapshot)
    expect(result.intents).toHaveLength(1)
    expect(result.intents[0].disposition).toBe('review_required')
    expect(result.intents[0]).not.toHaveProperty('referenceId')
    expect(result.intents[0]).not.toHaveProperty('provenance')
    expect(result.intents[0]).not.toHaveProperty('kind', 'add-reference')
  })

  it('requires a completed proposing OutputStep before examining artifacts', () => {
    const noneStep: OutputStep = {
      ...outputStep,
      output: { ...outputStep.output, projectReference: 'none' }
    }
    const notRequested = planExecutionArtifactPromotion({
      executionId: 'execution-1',
      projectId: 'project-1',
      rootChatId: 'chat-root',
      outputStep: noneStep,
      outputAttempt: { ...outputAttempt, stepId: noneStep.id },
      upstreamAttempts: [providerAttempt([artifact('ignored-a', '/workspace/ignored.md')])]
    })
    const incomplete = planExecutionArtifactPromotion({
      executionId: 'execution-1',
      projectId: 'project-1',
      rootChatId: 'chat-root',
      outputStep,
      outputAttempt: { ...outputAttempt, state: 'running' },
      upstreamAttempts: [providerAttempt([artifact('ignored-b', '/workspace/ignored.md')])]
    })

    expect(notRequested).toMatchObject({
      intents: [],
      diagnostics: [{ code: 'promotion_not_requested' }]
    })
    expect(incomplete).toMatchObject({
      intents: [],
      diagnostics: [{ code: 'output_step_not_completed' }]
    })
  })
})
