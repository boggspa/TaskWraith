import { describe, expect, it } from 'vitest'
import type { ExecutionRunProjection } from './ExecutionGraphRun'
import type { RunQueueJob } from '../store/types'
import {
  canonicalExecutionGraphRunId,
  isExecutionGraphReservedRunIdentity
} from './ExecutionGraphRunIdentity'

function projection(anchorRunRef: string): ExecutionRunProjection {
  return {
    executionId: 'stack-one',
    title: 'Stack',
    workspaceId: 'workspace-one',
    tenant: { kind: 'stack', tenantId: 'chat-one' },
    rootChatId: 'chat-one',
    anchorRunRef,
    state: 'cancelled',
    topology: { steps: [], edges: [] },
    topologyDigest: 'a'.repeat(64),
    activations: {},
    attempts: {},
    eventCount: 1,
    lastSequence: 1,
    integrity: 'valid',
    baseRevisionMissing: false,
    diagnostics: []
  }
}

describe('execution graph run identity reservation', () => {
  it('canonicalizes a queue id alias before comparing a terminal Stack anchor', () => {
    const anchorJob = {
      id: 'job-alias',
      runId: 'anchor-run',
      provider: 'codex',
      scope: 'workspace',
      source: 'manual',
      status: 'active'
    } as RunQueueJob
    const getRunQueueJob = (value: string) =>
      value === 'job-alias' || value === 'anchor-run' ? anchorJob : null

    expect(canonicalExecutionGraphRunId('job-alias', getRunQueueJob)).toBe('anchor-run')
    expect(
      isExecutionGraphReservedRunIdentity({
        runId: 'job-alias',
        getRunQueueJob,
        listExecutions: () => [projection('anchor-run')]
      })
    ).toBe(true)
  })
})
