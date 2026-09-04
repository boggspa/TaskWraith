import { describe, expect, it } from 'vitest'
import { WORKFLOW_HISTORY_LIMIT } from '../../ScheduledOccurrenceMutationSemantics'
import {
  normalizeChatWorkflowMode,
  normalizeUnattendedElevationAck,
  normalizeWorkflowDefinitionRecord,
  normalizeWorkflowExecutionRecord,
  normalizeWorkflowTemplate
} from './workflowNormalizers'

const NOW_MS = Date.parse('2026-09-04T08:00:00.000Z')
const NOW_ISO = '2026-09-04T08:00:00.000Z'
const AUTHORITY_DIGEST = 'ab'.repeat(32)

function validTemplate(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Review the current diff.',
    ...overrides
  }
}

function validAck(overrides: Record<string, unknown> = {}) {
  return {
    level: 'default',
    acknowledgedAt: NOW_ISO,
    acknowledgedApprovalMode: 'default',
    authorityDigest: AUTHORITY_DIGEST,
    signature: 'sig-1',
    ...overrides
  }
}

describe('workflowNormalizers', () => {
  it('canonicalizes chat workflow mode and treats missing/legacy values as normal', () => {
    expect(normalizeChatWorkflowMode('plan')).toBe('plan')
    expect(normalizeChatWorkflowMode('normal')).toBe('normal')
    expect(normalizeChatWorkflowMode(undefined)).toBe('normal')
    expect(normalizeChatWorkflowMode(null)).toBe('normal')
    expect(normalizeChatWorkflowMode('mystery')).toBe('normal')
  })

  it('rejects execution records without an id or with an unknown status', () => {
    expect(normalizeWorkflowExecutionRecord(null, 'wf-1')).toBeNull()
    expect(normalizeWorkflowExecutionRecord({}, 'wf-1')).toBeNull()
    expect(normalizeWorkflowExecutionRecord({ id: '' }, 'wf-1')).toBeNull()
    expect(normalizeWorkflowExecutionRecord({ id: 'exec-1', status: 'mystery' }, 'wf-1')).toBeNull()
  })

  it('defaults missing execution status and timestamps and keeps optional fields', () => {
    const record = normalizeWorkflowExecutionRecord(
      {
        id: 'exec-1',
        scheduledTaskId: 'task-1',
        runId: 'run-1',
        startedAt: NOW_ISO,
        completedAt: NOW_ISO,
        error: 'boom'
      },
      'wf-1'
    )
    expect(record).toMatchObject({
      id: 'exec-1',
      workflowId: 'wf-1',
      status: 'queued',
      scheduledTaskId: 'task-1',
      runId: 'run-1',
      startedAt: NOW_ISO,
      completedAt: NOW_ISO,
      error: 'boom'
    })
    expect(record?.plannedFor).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(record?.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(
      normalizeWorkflowExecutionRecord(
        {
          id: 'exec-2',
          status: 'completed',
          plannedFor: NOW_ISO,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO
        },
        'wf-1'
      )?.status
    ).toBe('completed')
  })

  it('rejects templates missing required identity or prompt', () => {
    expect(normalizeWorkflowTemplate(null)).toBeNull()
    expect(normalizeWorkflowTemplate({})).toBeNull()
    expect(normalizeWorkflowTemplate(validTemplate({ workspaceId: '' }))).toBeNull()
    expect(normalizeWorkflowTemplate(validTemplate({ prompt: 12 }))).toBeNull()
  })

  it('fills template defaults and discards legacy sessionTrust / missing workflowMode', () => {
    const template = normalizeWorkflowTemplate(
      validTemplate({
        sessionTrust: true,
        imageAttachments: 'not-an-array'
      })
    )
    expect(template).toMatchObject({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Review the current diff.',
      selectedModelType: 'default',
      customModel: '',
      approvalMode: 'default',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: []
    })
    expect(normalizeWorkflowTemplate(validTemplate({ workflowMode: 'plan' }))?.workflowMode).toBe(
      'plan'
    )
  })

  it('rejects workflow definitions without a usable template', () => {
    expect(normalizeWorkflowDefinitionRecord(null, NOW_MS)).toBeNull()
    expect(normalizeWorkflowDefinitionRecord({}, NOW_MS)).toBeNull()
    expect(normalizeWorkflowDefinitionRecord({ template: { prompt: 'x' } }, NOW_MS)).toBeNull()
  })

  it('normalizes definition policies, names, history cap, and loop/elevation fallbacks', () => {
    const history: Array<Record<string, unknown>> = Array.from(
      { length: WORKFLOW_HISTORY_LIMIT + 3 },
      (_, i) => ({
        id: `exec-${i}`,
        status: 'completed',
        plannedFor: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO
      })
    )
    history.splice(1, 0, { id: '', status: 'queued' })
    const record = normalizeWorkflowDefinitionRecord(
      {
        id: 'wf-1',
        name: '  Audit loop  ',
        template: validTemplate({
          prompt: 'Review the current diff.',
          workflowMode: 'plan'
        }),
        trigger: {
          kind: 'interval',
          intervalMs: 15 * 60_000,
          startAt: NOW_ISO
        },
        missedRunPolicy: 'skip',
        concurrencyPolicy: 'enqueue',
        nextRunAt: NOW_ISO,
        limits: { maxConsecutiveFailures: 4.8 },
        lastRunIterationCount: 2.9,
        lastRunTokens: -3,
        failureStreak: 'nope',
        history,
        unattendedElevation: validAck(),
        loop: { acceptance: { maxIterations: 7 } },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO
      },
      NOW_MS
    )
    expect(record).toMatchObject({
      id: 'wf-1',
      name: 'Audit loop',
      enabled: true,
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'enqueue',
      lastRunIterationCount: 2,
      lastRunTokens: 0,
      failureStreak: 0
    })
    expect(record?.limits.maxConsecutiveFailures).toBe(4)
    expect(record?.template.workflowMode).toBe('plan')
    expect(record?.history).toHaveLength(WORKFLOW_HISTORY_LIMIT)
    expect(record?.history[0]?.id).toBe('exec-3')
    expect(record?.history.at(-1)?.id).toBe(`exec-${WORKFLOW_HISTORY_LIMIT + 2}`)
    expect(record?.unattendedElevation?.level).toBe('default')
    expect(record?.loop?.acceptance.maxIterations).toBe(7)
    expect(record?.trigger.kind).toBe('interval')
    expect(record?.nextRunAt).toBe(NOW_ISO)

    const fallback = normalizeWorkflowDefinitionRecord(
      {
        template: validTemplate({ prompt: '' }),
        missedRunPolicy: 'other',
        concurrencyPolicy: 'other',
        enabled: false
      },
      NOW_MS
    )
    expect(fallback?.name).toBe('Workflow')
    expect(fallback?.missedRunPolicy).toBe('coalesce')
    expect(fallback?.concurrencyPolicy).toBe('skip')
    expect(fallback?.enabled).toBe(false)
    expect(fallback?.nextRunAt).toBeUndefined()
    expect(fallback?.id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
  })

  it('keeps a well-formed unattended elevation ack and drops legacy/partial blobs', () => {
    expect(normalizeUnattendedElevationAck(validAck())).toEqual({
      level: 'default',
      acknowledgedAt: NOW_ISO,
      acknowledgedApprovalMode: 'default',
      authorityDigest: AUTHORITY_DIGEST,
      signature: 'sig-1'
    })
    expect(normalizeUnattendedElevationAck(null)).toBeUndefined()
    expect(normalizeUnattendedElevationAck({ ...validAck(), level: 'mystery' })).toBeUndefined()
    expect(
      normalizeUnattendedElevationAck({ ...validAck(), authorityDigest: 'not-hex' })
    ).toBeUndefined()
    expect(normalizeUnattendedElevationAck({ ...validAck(), signature: '' })).toBeUndefined()
    expect(normalizeUnattendedElevationAck({ ...validAck(), acknowledgedAt: '' })).toBeUndefined()
  })
})
