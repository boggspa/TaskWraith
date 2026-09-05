import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant, ToolActivity, ToolDiffSummary } from '../store/types'
import {
  buildEnsembleToolActivity,
  extractToolId,
  extractToolKind,
  extractToolName,
  getEnsembleToolCategory,
  getEnsembleToolDisplayName,
  getStringParameter,
  isEnsembleReasoningToolName,
  mapEnsembleToolKindToCategory,
  mergeToolDiffSummaries,
  pairEnsembleToolResult,
  participantLabel,
  stripToolNamespace,
  titleCaseToolName
} from './EnsembleToolActivity'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'reviewer',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: '',
    order: 1,
    ...overrides
  }
}

function worker(): EnsembleParticipant {
  return participant({
    id: 'worker',
    provider: 'codex',
    role: 'Worker',
    order: 2
  })
}

function summary(overrides: Partial<ToolDiffSummary> = {}): ToolDiffSummary {
  return {
    additions: 0,
    deletions: 0,
    source: 'unknown',
    confidence: 'unknown',
    ...overrides
  }
}

const measured = (additions: number, deletions: number): ToolDiffSummary =>
  summary({ additions, deletions, source: 'git_numstat', confidence: 'exact' })

function runningActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'running',
    startedAt: '2026-09-05T00:00:00.000Z',
    parameters: {},
    ...overrides
  }
}

describe('extractToolId', () => {
  it('reads the first present id field', () => {
    expect(extractToolId({ tool_id: 'a' })).toBe('a')
    expect(extractToolId({ toolId: 'b' })).toBe('b')
    expect(extractToolId({ id: 'c' })).toBe('c')
    expect(extractToolId({ call_id: 'd' })).toBe('d')
    expect(extractToolId({ tool_call_id: 'e' })).toBe('e')
  })

  it('synthesizes an ensemble-tool id when none is present', () => {
    expect(extractToolId({})).toMatch(/^ensemble-tool-\d+-\w+$/)
    expect(extractToolId(null)).toMatch(/^ensemble-tool-\d+-\w+$/)
  })
})

describe('extractToolName / extractToolKind', () => {
  it('reads tool name aliases and defaults to unknown', () => {
    expect(extractToolName({ tool_name: 'read_file' })).toBe('read_file')
    expect(extractToolName({ toolName: 'writeFile' })).toBe('writeFile')
    expect(extractToolName({ name: 'search' })).toBe('search')
    expect(extractToolName({ function: { name: 'replace' } })).toBe('replace')
    expect(extractToolName({ tool: 'shell' })).toBe('shell')
    expect(extractToolName({})).toBe('unknown')
    expect(extractToolName(null)).toBe('unknown')
  })

  it('normalizes kind to a trimmed lowercase string', () => {
    expect(extractToolKind({ tool_kind: 'Edit' })).toBe('edit')
    expect(extractToolKind({ toolKind: ' READ ' })).toBe('read')
    expect(extractToolKind({ kind: 'search' })).toBe('search')
    expect(extractToolKind({})).toBe('')
    expect(extractToolKind({ kind: 12 })).toBe('')
  })
})

describe('stripToolNamespace', () => {
  it('strips MCP and TaskWraith broker prefixes', () => {
    expect(stripToolNamespace('mcp__TaskWraith__read_file')).toBe('read_file')
    expect(stripToolNamespace('mcp_taskwraith_ensemble_yield')).toBe('ensemble_yield')
    expect(stripToolNamespace('mcp_TaskWraith_ensemble_yield')).toBe('ensemble_yield')
    expect(stripToolNamespace('taskwraith-broker__write_file')).toBe('write_file')
    expect(stripToolNamespace('taskwraith__ensemble_yield')).toBe('ensemble_yield')
    expect(stripToolNamespace('read_file')).toBe('read_file')
  })

  it('returns unknown for a blank name', () => {
    expect(stripToolNamespace('')).toBe('unknown')
    expect(stripToolNamespace('   ')).toBe('unknown')
  })
})

describe('getStringParameter / titleCaseToolName / participantLabel', () => {
  it('returns the first non-empty string parameter', () => {
    expect(getStringParameter({ path: '/tmp/a' }, ['file_path', 'path'])).toBe('/tmp/a')
    expect(getStringParameter({ file_path: '  x  ' }, ['file_path'])).toBe('x')
    expect(getStringParameter({ path: '' }, ['path'])).toBe('')
  })

  it('title-cases names and keeps MCP as an acronym', () => {
    expect(titleCaseToolName('mcp')).toBe('MCP')
    expect(titleCaseToolName('read_file')).toBe('Read File')
    expect(titleCaseToolName('ensemble_yield')).toBe('Ensemble Yield')
  })

  it('labels a participant by role, then provider, then a fallback', () => {
    expect(participantLabel(participant())).toBe('Reviewer')
    expect(participantLabel(participant({ role: '' }))).toBe('claude')
    expect(participantLabel(undefined)).toBe('Participant')
  })
})

describe('mapEnsembleToolKindToCategory / getEnsembleToolCategory', () => {
  it('maps structured kinds onto activity categories', () => {
    expect(mapEnsembleToolKindToCategory('read')).toBe('read')
    expect(mapEnsembleToolKindToCategory('edit')).toBe('write')
    expect(mapEnsembleToolKindToCategory('delete')).toBe('write')
    expect(mapEnsembleToolKindToCategory('search')).toBe('search')
    expect(mapEnsembleToolKindToCategory('execute')).toBe('shell')
    expect(mapEnsembleToolKindToCategory('thinking')).toBe('task')
    expect(mapEnsembleToolKindToCategory('other')).toBeUndefined()
  })

  it('lets structured kind outrank a freeform name', () => {
    expect(getEnsembleToolCategory('Write package.json', 'edit')).toBe('write')
  })

  it('categorizes namespaced yield, reasoning, and file tools', () => {
    expect(getEnsembleToolCategory('mcp_TaskWraith_ensemble_yield')).toBe('task')
    expect(getEnsembleToolCategory('grok_thinking')).toBe('task')
    expect(getEnsembleToolCategory('read_file')).toBe('read')
    expect(getEnsembleToolCategory('write_file')).toBe('write')
    expect(getEnsembleToolCategory('run_shell_command')).toBe('shell')
    expect(getEnsembleToolCategory('web_search')).toBe('search')
    expect(isEnsembleReasoningToolName('grok_thinking')).toBe(true)
    expect(isEnsembleReasoningToolName('read_file')).toBe(false)
  })
})

describe('getEnsembleToolDisplayName', () => {
  it('persists yield actor and resolved target labels', () => {
    const roster = [participant(), worker()]
    expect(
      getEnsembleToolDisplayName(
        'mcp_TaskWraith_ensemble_yield',
        { target: 'Worker' },
        participant(),
        roster
      )
    ).toBe('Reviewer yielding to Worker')
    expect(getEnsembleToolDisplayName('ensemble_yield', {}, participant())).toBe(
      'Reviewer yielding'
    )
  })

  it("keeps an unresolvable yield target in the model's own words", () => {
    expect(
      getEnsembleToolDisplayName('ensemble_yield', { target: 'Fixman' }, participant(), [
        participant(),
        worker()
      ])
    ).toBe('Reviewer yielding to Fixman')
  })

  it('humanises file and topic tools', () => {
    expect(getEnsembleToolDisplayName('read_file', { file_path: '/tmp/notes.md' })).toBe(
      'Read /tmp/notes.md'
    )
    expect(getEnsembleToolDisplayName('move_path', { from: 'a.ts', to: 'b.ts' })).toBe(
      'Moved a.ts -> b.ts'
    )
    expect(getEnsembleToolDisplayName('update_topic', { title: 'Plan' })).toBe('Topic update: Plan')
  })
})

describe('mergeToolDiffSummaries measured-diff precedence', () => {
  it('lets a smaller measured summary beat an inflated estimate', () => {
    const inflated = summary({
      additions: 40,
      deletions: 40,
      source: 'string_replace',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummaries(inflated, measured(1, 1), 'src/app.ts')).toMatchObject({
      additions: 1,
      deletions: 1,
      source: 'git_numstat',
      confidence: 'exact'
    })
  })

  it('never lets a later estimate displace measured truth', () => {
    const existing = measured(2, 1)
    const hugeEstimate = summary({
      additions: 9999,
      deletions: 9999,
      source: 'patch_preview',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummaries(existing, hugeEstimate, 'src/app.ts')).toMatchObject({
      additions: 2,
      deletions: 1,
      source: 'git_numstat',
      confidence: 'exact'
    })
  })

  it('prefers a later summary when only it has counts', () => {
    const existing = summary({ source: 'unknown', confidence: 'estimated' })
    delete (existing as { additions?: number }).additions
    delete (existing as { deletions?: number }).deletions
    const later = summary({
      additions: 4,
      deletions: 0,
      source: 'content',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummaries(existing, later, 'notes.md')).toMatchObject({
      additions: 4,
      deletions: 0,
      source: 'content'
    })
  })
})

describe('buildEnsembleToolActivity', () => {
  it('seeds write-file counts and yield labels', () => {
    const write = buildEnsembleToolActivity(
      {
        tool_id: 'write-1',
        tool_name: 'write_file',
        parameters: { path: 'local-p5-smoke.md', content: 'one\ntwo\nthree\nfour' }
      },
      '2026-09-05T00:00:00.000Z',
      participant()
    )
    expect(write).toMatchObject({
      id: 'write-1',
      toolName: 'write_file',
      displayName: 'Edited local-p5-smoke.md',
      category: 'write',
      filePath: 'local-p5-smoke.md',
      diffSummary: {
        additions: 4,
        deletions: 0,
        source: 'content',
        confidence: 'estimated'
      }
    })

    const yieldActivity = buildEnsembleToolActivity(
      {
        tool_id: 'yield-1',
        tool_name: 'mcp_TaskWraith_ensemble_yield',
        parameters: { target: 'Worker' }
      },
      '2026-09-05T00:00:00.000Z',
      participant(),
      [participant(), worker()]
    )
    expect(yieldActivity).toMatchObject({
      displayName: 'Reviewer yielding to Worker',
      category: 'task',
      status: 'running'
    })
  })

  it('coalesces image viewers onto Image View with a parameter image count', () => {
    const input =
      'const paths = ["one.png", "two.png", "three.png", "four.png"]; for (const path of paths) await tools.view_image({ path });'
    const activity = buildEnsembleToolActivity(
      {
        tool_id: 'codex-images',
        tool_name: 'exec',
        input
      },
      '2026-09-05T00:00:00.000Z',
      participant()
    )
    expect(activity).toMatchObject({
      toolName: 'image_view',
      displayName: 'Image View',
      category: 'read',
      parameters: { input, imageCount: 4 }
    })
  })
})

describe('pairEnsembleToolResult', () => {
  it('converts yielding labels to yielded on success', () => {
    const activity = runningActivity({
      toolName: 'mcp_TaskWraith_ensemble_yield',
      displayName: 'Reviewer yielding to Worker',
      category: 'task',
      parameters: { target: 'Worker' }
    })
    const paired = pairEnsembleToolResult(
      activity,
      { content: 'Yielded.' },
      '2026-09-05T00:00:01.000Z'
    )
    expect(paired).toMatchObject({
      displayName: 'Reviewer yielded to Worker',
      status: 'success',
      resultSummary: 'Yielded.'
    })
  })

  it('caps ordinary output at 500 characters and leaves reasoning traces intact', () => {
    const ordinary = pairEnsembleToolResult(
      runningActivity(),
      { content: `${'x'.repeat(520)}tail` },
      '2026-09-05T00:00:01.000Z'
    )
    expect(ordinary.resultSummary).toHaveLength(503)
    expect(ordinary.resultSummary?.endsWith('...')).toBe(true)
    expect(ordinary.resultSummary).not.toContain('tail')

    const trace = `${'reasoning trace '.repeat(120)}tail sentinel`
    const reasoning = pairEnsembleToolResult(
      runningActivity({
        toolName: 'grok_thinking',
        displayName: 'Grok Thinking',
        category: 'task'
      }),
      { output: trace },
      '2026-09-05T00:00:01.000Z'
    )
    expect(reasoning.resultSummary).toBe(trace)
    expect(reasoning.resultSummary).toContain('tail sentinel')
    expect(reasoning.resultSummary).not.toMatch(/\.\.\.$/)
  })

  it('prefers returned image counts on image-view results', () => {
    const activity = runningActivity({
      toolName: 'image_view',
      displayName: 'Image View',
      category: 'read',
      parameters: { input: 'view_image', imageCount: 4 }
    })
    const paired = pairEnsembleToolResult(
      activity,
      {
        content: [
          { type: 'image', mimeType: 'image/png', data: 'one' },
          { type: 'image', mimeType: 'image/png', data: 'two' }
        ]
      },
      '2026-09-05T00:00:01.000Z'
    )
    expect(paired).toMatchObject({
      toolName: 'image_view',
      displayName: 'Image View',
      category: 'read',
      parameters: { input: 'view_image', imageCount: 2 }
    })
  })
})
