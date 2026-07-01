import { describe, expect, it } from 'vitest'
import {
  isClaudeWorkflowSystemEvent,
  isClaudeWorkflowToolName,
  mergeClaudeWorkflowTelemetry,
  normalizeClaudeWorkflowEvent,
  parseWorkflowScriptMeta,
  shouldEmitClaudeWorkflowTelemetry,
  type ClaudeWorkflowTelemetry
} from './claudeWorkflow'

describe('isClaudeWorkflowSystemEvent', () => {
  it('matches the task-lifecycle system subtypes', () => {
    for (const subtype of ['task_started', 'task_progress', 'task_updated', 'task_notification']) {
      expect(isClaudeWorkflowSystemEvent({ type: 'system', subtype })).toBe(true)
    }
  })

  it('rejects non-workflow system frames and other shapes', () => {
    expect(isClaudeWorkflowSystemEvent({ type: 'system', subtype: 'init' })).toBe(false)
    expect(isClaudeWorkflowSystemEvent({ type: 'assistant' })).toBe(false)
    expect(isClaudeWorkflowSystemEvent({ type: 'result', subtype: 'task_progress' })).toBe(false)
    expect(isClaudeWorkflowSystemEvent(null)).toBe(false)
    expect(isClaudeWorkflowSystemEvent('task_started')).toBe(false)
  })
})

describe('normalizeClaudeWorkflowEvent', () => {
  it('extracts name/description/taskType/status from task_started', () => {
    const out = normalizeClaudeWorkflowEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task_1',
      tool_use_id: 'toolu_99',
      task_type: 'local_workflow',
      workflow_name: 'howto-docs-audit',
      description: 'Haiku audit of the docs'
    })
    expect(out).not.toBeNull()
    expect(out?.taskId).toBe('task_1')
    expect(out?.toolUseId).toBe('toolu_99')
    expect(out?.taskType).toBe('local_workflow')
    expect(out?.telemetry.workflowName).toBe('howto-docs-audit')
    expect(out?.telemetry.description).toBe('Haiku audit of the docs')
    expect(out?.telemetry.status).toBe('running')
  })

  it('reads the full runtime usage bag from task_progress (incl agent_count)', () => {
    const out = normalizeClaudeWorkflowEvent({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task_1',
      tool_use_id: 'toolu_99',
      last_tool_name: 'audit-sweep',
      usage: {
        total_tokens: 278700,
        tool_uses: 239,
        duration_ms: 31000,
        agent_count: 14,
        subagent_tokens: 564211
      }
    })
    expect(out?.telemetry.totalTokens).toBe(278700)
    expect(out?.telemetry.toolUses).toBe(239)
    expect(out?.telemetry.durationMs).toBe(31000)
    expect(out?.telemetry.agentCount).toBe(14)
    expect(out?.telemetry.subagentTokens).toBe(564211)
    expect(out?.telemetry.lastToolName).toBe('audit-sweep')
    expect(out?.telemetry.status).toBe('running')
  })

  it('maps a terminal task_notification', () => {
    const out = normalizeClaudeWorkflowEvent({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task_1',
      tool_use_id: 'toolu_99',
      status: 'completed',
      summary: 'Audited 14 docs.',
      output_file: '/tmp/out.txt',
      usage: { total_tokens: 300000, tool_uses: 250, duration_ms: 40000 }
    })
    expect(out?.telemetry.status).toBe('completed')
    expect(out?.telemetry.summary).toBe('Audited 14 docs.')
    expect(out?.telemetry.outputFile).toBe('/tmp/out.txt')
    expect(out?.telemetry.totalTokens).toBe(300000)
  })

  it('reads status + error from a task_updated patch', () => {
    const out = normalizeClaudeWorkflowEvent({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task_1',
      tool_use_id: 'toolu_99',
      patch: { status: 'failed', error: 'script threw', is_backgrounded: true }
    })
    expect(out?.telemetry.status).toBe('failed')
    expect(out?.telemetry.error).toBe('script threw')
    expect(out?.telemetry.isBackgrounded).toBe(true)
  })

  it('returns null for non-workflow events', () => {
    expect(normalizeClaudeWorkflowEvent({ type: 'assistant' })).toBeNull()
    expect(normalizeClaudeWorkflowEvent({ type: 'system', subtype: 'init' })).toBeNull()
    expect(normalizeClaudeWorkflowEvent(undefined)).toBeNull()
  })
})

describe('shouldEmitClaudeWorkflowTelemetry', () => {
  it('admits local Workflow starts', () => {
    expect(
      shouldEmitClaudeWorkflowTelemetry({ taskId: 'task_1', taskType: 'local_workflow' }, new Set())
    ).toBe(true)
  })

  it('admits later frames for known workflow task ids', () => {
    expect(
      shouldEmitClaudeWorkflowTelemetry(
        { taskId: 'task_1', taskType: 'background_task' },
        new Set(['task_1'])
      )
    ).toBe(true)
  })

  it('rejects unknown non-workflow tasks even when the frame has workflow_name telemetry', () => {
    const normalized = normalizeClaudeWorkflowEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task_2',
      tool_use_id: 'toolu_task',
      task_type: 'background_task',
      workflow_name: 'not-a-workflow'
    })

    expect(normalized?.telemetry.workflowName).toBe('not-a-workflow')
    expect(shouldEmitClaudeWorkflowTelemetry(normalized, new Set())).toBe(false)
  })
})

describe('mergeClaudeWorkflowTelemetry', () => {
  it('keeps prior fields when the next patch is sparse', () => {
    const prev: ClaudeWorkflowTelemetry = {
      workflowName: 'audit',
      description: 'desc',
      status: 'running'
    }
    const merged = mergeClaudeWorkflowTelemetry(prev, { totalTokens: 100, status: 'running' })
    expect(merged.workflowName).toBe('audit')
    expect(merged.description).toBe('desc')
    expect(merged.totalTokens).toBe(100)
  })

  it('never downgrades a terminal status back to running', () => {
    const prev: ClaudeWorkflowTelemetry = { status: 'completed', totalTokens: 200 }
    const merged = mergeClaudeWorkflowTelemetry(prev, { status: 'running', totalTokens: 210 })
    expect(merged.status).toBe('completed')
    expect(merged.totalTokens).toBe(210)
  })

  it('ignores empty-string/undefined incoming fields', () => {
    const prev: ClaudeWorkflowTelemetry = { workflowName: 'audit' }
    const merged = mergeClaudeWorkflowTelemetry(prev, { workflowName: '', summary: undefined })
    expect(merged.workflowName).toBe('audit')
    expect(merged.summary).toBeUndefined()
  })
})

describe('parseWorkflowScriptMeta', () => {
  it('extracts name, description, and phase titles from the meta literal', () => {
    const script = [
      'export const meta = {',
      "  name: 'howto-docs-audit',",
      "  description: 'Audit the docs',",
      '  phases: [',
      "    { title: 'Audit', detail: 'check' },",
      "    { title: 'Sweep', detail: 'fix' },",
      '  ],',
      '}',
      "phase('Audit')",
      "const x = await agent('something with name: not-a-phase')"
    ].join('\n')
    const meta = parseWorkflowScriptMeta(script)
    expect(meta.name).toBe('howto-docs-audit')
    expect(meta.description).toBe('Audit the docs')
    expect(meta.phases).toEqual(['Audit', 'Sweep'])
  })

  it('returns an empty object for non-string / empty input', () => {
    expect(parseWorkflowScriptMeta(undefined)).toEqual({})
    expect(parseWorkflowScriptMeta('')).toEqual({})
    expect(parseWorkflowScriptMeta(123 as unknown as string)).toEqual({})
  })

  it('keeps all phases when a phase object carries a nested array field', () => {
    // Regression: a non-greedy `[...]` capture stopped at the first `]` (the
    // nested agents/retries array), silently dropping later phases.
    const script = [
      'export const meta = {',
      "  name: 'loop',",
      '  phases: [',
      "    { id: 'maker', title: 'Draft changes', agents: ['claude'], retries: [1, 2, 3] },",
      "    { id: 'verifier', title: 'Verify changes' },",
      "    { id: 'decide', title: 'Decide next step' }",
      '  ]',
      '}'
    ].join('\n')
    expect(parseWorkflowScriptMeta(script).phases).toEqual([
      'Draft changes',
      'Verify changes',
      'Decide next step'
    ])
  })

  it('uses the top-level name, not a nested phase name declared first', () => {
    const script = [
      'export const meta = {',
      "  phases: [{ name: 'maker', title: 'Draft' }, { name: 'verifier', title: 'Verify' }],",
      "  name: 'My Real Workflow Name'",
      '}'
    ].join('\n')
    const meta = parseWorkflowScriptMeta(script)
    expect(meta.name).toBe('My Real Workflow Name')
    expect(meta.phases).toEqual(['Draft', 'Verify'])
  })

  it('handles escaped quotes inside a name/title without truncating', () => {
    const script = [
      'export const meta = {',
      "  name: 'Chris\\'s audit',",
      "  phases: [{ title: 'It\\'s phase one' }]",
      '}'
    ].join('\n')
    const meta = parseWorkflowScriptMeta(script)
    expect(meta.name).toBe("Chris's audit")
    expect(meta.phases).toEqual(["It's phase one"])
  })

  it('tolerates a script truncated mid-phases (returns what parsed)', () => {
    const script = [
      'export const meta = {',
      "  name: 'trunc',",
      "  phases: [{ title: 'Phase A' }, { title: 'Phase B' }"
    ].join('\n')
    expect(parseWorkflowScriptMeta(script).phases).toEqual(['Phase A', 'Phase B'])
  })
})

describe('isClaudeWorkflowToolName', () => {
  it('matches Workflow in bare and namespaced forms', () => {
    expect(isClaudeWorkflowToolName('Workflow')).toBe(true)
    expect(isClaudeWorkflowToolName('workflow')).toBe(true)
    expect(isClaudeWorkflowToolName('mcp__claude__Workflow')).toBe(true)
  })

  it('rejects other tools', () => {
    expect(isClaudeWorkflowToolName('Task')).toBe(false)
    expect(isClaudeWorkflowToolName('workflow_run_history')).toBe(false)
    expect(isClaudeWorkflowToolName('')).toBe(false)
    expect(isClaudeWorkflowToolName(null)).toBe(false)
  })
})
