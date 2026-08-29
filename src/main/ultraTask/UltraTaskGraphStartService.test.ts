import { describe, expect, it, vi } from 'vitest'
import type { RunPermissionPostureSnapshot } from '../store/types'
import { executionGraphRunTemplatePermissionCeilingDigest } from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import {
  startPreparedUltraTaskGraph,
  type UltraTaskGraphStartServiceDeps
} from './UltraTaskGraphStartService'

function posture(readOnly: boolean): RunPermissionPostureSnapshot {
  return {
    schemaVersion: 1,
    approvalMode: readOnly ? 'plan' : 'auto_edit',
    workflowMode: readOnly ? 'plan' : 'normal',
    presetId: readOnly ? 'read_only' : 'workspace_write',
    readOnly,
    agenticServices: {
      shellCommands: readOnly ? 'deny' : 'allow',
      fileChanges: readOnly ? 'deny' : 'allow',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'ask',
      meshCanvas: 'ask',
      simulatorCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'deny',
      webBrowsing: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrantCount: 0,
    workspaceGrantServiceIds: [],
    signaturePresent: true,
    signature: `${readOnly ? 'read' : 'write'}-signature`,
    context: {},
    postureHash: `${readOnly ? 'read' : 'write'}-posture`
  }
}

function deps() {
  const templates: Array<{ templateId: string; content: any }> = []
  const resolvePermissionPosture = vi.fn(({ request }) => posture(request.approvalMode === 'plan'))
  const saveRunTemplate = vi.fn((content) => {
    const record = { templateId: `template-${templates.length + 1}`, content }
    templates.push(record)
    return record
  })
  const saveRevision = vi.fn((revision) => revision)
  const startExecutionGraph = vi.fn(
    (request) =>
      ({
        executionId: request.executionId,
        state: 'running',
        topology: { steps: request.revision.steps, edges: request.revision.edges },
        topologyDigest: 'digest',
        activations: {},
        attempts: {},
        eventCount: 1,
        lastSequence: 1,
        integrity: 'valid',
        baseRevisionMissing: false,
        diagnostics: []
      }) as ExecutionRunProjection
  )
  let id = 0
  const result: UltraTaskGraphStartServiceDeps = {
    resolvePermissionPosture,
    saveRunTemplate,
    saveRevision,
    startExecutionGraph,
    createId: (kind) => `${kind}-${++id}`,
    now: () => '2026-08-24T02:00:00.000Z'
  }
  return {
    deps: result,
    templates,
    resolvePermissionPosture,
    saveRunTemplate,
    saveRevision,
    startExecutionGraph
  }
}

describe('startPreparedUltraTaskGraph', () => {
  it('persists every stage template and starts one unanchored workflow', () => {
    const harness = deps()
    const started = startPreparedUltraTaskGraph(
      {
        title: 'Parser UltraTask',
        task: 'Implement and verify the parser.',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'ultracode',
        workspaceId: 'workspace-one',
        workspacePath: '/workspace',
        rootChatId: 'chat-one',
        owner: {
          threadId: 'chat-one',
          initiatingRunId: 'run-parent-1',
          seatId: 'codex:gpt-5.6-sol'
        },
        parentApprovalMode: 'auto_edit',
        parentPermissionPresetId: 'workspace_write',
        parentWorkflowMode: 'normal',
        workerEffect: 'workspace_write',
        scoutCount: 2
      },
      harness.deps
    )

    expect(harness.saveRunTemplate).toHaveBeenCalledTimes(5)
    expect(harness.resolvePermissionPosture).toHaveBeenCalledTimes(6) // ceiling + five stages
    expect(harness.startExecutionGraph).toHaveBeenCalledOnce()
    expect(harness.startExecutionGraph.mock.calls[0]?.[0]).not.toHaveProperty('anchorRunRef')
    expect(started.executionId).toBe(started.workflowId)
  })

  it('uses the worker envelope as parent ceiling and narrower read-only stage digests', () => {
    const harness = deps()
    startPreparedUltraTaskGraph(
      {
        task: 'Implement safely.',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        workspaceId: 'workspace-one',
        workspacePath: '/workspace',
        rootChatId: 'chat-one',
        owner: {
          threadId: 'chat-one',
          initiatingRunId: 'run-parent-1',
          seatId: 'codex:gpt-5.6-sol'
        },
        parentApprovalMode: 'auto_edit',
        parentPermissionPresetId: 'workspace_write',
        workerEffect: 'workspace_write'
      },
      harness.deps
    )

    const start = harness.startExecutionGraph.mock.calls[0]?.[0]
    const workerTemplate = harness.templates.find((entry) =>
      String(entry.content.request?.prompt).startsWith('Execute the task')
    )
    const scoutTemplate = harness.templates.find((entry) =>
      String(entry.content.request?.prompt).startsWith('UltraTask scout')
    )
    if (!start || !workerTemplate || !scoutTemplate) throw new Error('Missing fixture output.')
    expect(start.permissionCeilingRef.authorityDigest).toBe(
      executionGraphRunTemplatePermissionCeilingDigest(workerTemplate.content)
    )
    expect(executionGraphRunTemplatePermissionCeilingDigest(scoutTemplate.content)).not.toBe(
      start.permissionCeilingRef.authorityDigest
    )
    expect(scoutTemplate.content.permissionPosture).toMatchObject({ readOnly: true })
    expect(workerTemplate.content.permissionPosture).toMatchObject({ readOnly: false })
  })

  it('supports the real stage concurrency knob from two through six scouts', () => {
    for (const scoutCount of [2, 6]) {
      const harness = deps()
      const started = startPreparedUltraTaskGraph(
        {
          task: 'Run scouts.',
          provider: 'codex',
          model: 'gpt-5.6-luna',
          workspaceId: 'workspace-one',
          workspacePath: '/workspace',
          rootChatId: 'chat-one',
          owner: {
            threadId: 'chat-one',
            initiatingRunId: 'run-parent-1',
            seatId: 'codex:gpt-5.6-sol'
          },
          parentApprovalMode: 'plan',
          parentPermissionPresetId: 'read_only',
          workerEffect: 'read_only',
          scoutCount
        },
        harness.deps
      )
      expect(started.stageIds.scouts).toHaveLength(scoutCount)
      expect(started.revision.limits.maxConcurrentSteps).toBe(scoutCount)
    }
  })

  it('refuses an unsigned stage posture before any template or graph persists', () => {
    const harness = deps()
    harness.resolvePermissionPosture.mockReturnValue({
      ...posture(false),
      signaturePresent: false,
      signature: undefined
    })

    expect(() =>
      startPreparedUltraTaskGraph(
        {
          task: 'Do work.',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          workspaceId: 'workspace-one',
          workspacePath: '/workspace',
          rootChatId: 'chat-one',
          owner: {
            threadId: 'chat-one',
            initiatingRunId: 'run-parent-1',
            seatId: 'codex:gpt-5.6-sol'
          },
          parentApprovalMode: 'auto_edit',
          parentPermissionPresetId: 'workspace_write',
          workerEffect: 'workspace_write'
        },
        harness.deps
      )
    ).toThrow(/unsigned/i)
    expect(harness.saveRunTemplate).not.toHaveBeenCalled()
    expect(harness.saveRevision).not.toHaveBeenCalled()
    expect(harness.startExecutionGraph).not.toHaveBeenCalled()
  })
})
