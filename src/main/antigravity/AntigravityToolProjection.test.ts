import { describe, expect, it } from 'vitest'
import {
  parseAgyTranscriptLine,
  projectAgyStepTools,
  projectAgyTranscriptTools,
  type AgyTranscriptStep
} from './AntigravityToolProjection'

function makeStep(overrides: Partial<AgyTranscriptStep> = {}): AgyTranscriptStep {
  return {
    step_index: 3,
    source: 'MODEL',
    type: 'VIEW_FILE',
    status: 'DONE',
    created_at: '2026-08-06T02:48:50+01:00',
    content: '',
    ...overrides
  }
}

describe('parseAgyTranscriptLine', () => {
  it('parses a valid step line', () => {
    const line = JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'VIEW_FILE',
      status: 'DONE',
      created_at: '2026-08-06T02:48:50+01:00',
      content: 'File Path: `/path/to/file.ts`\nTotal Lines: 100',
      truncated_fields: ['content']
    })
    const step = parseAgyTranscriptLine(line)
    expect(step).toMatchObject({
      step_index: 3,
      source: 'MODEL',
      type: 'VIEW_FILE',
      status: 'DONE',
      truncated_fields: ['content']
    })
  })

  it('returns null for empty lines', () => {
    expect(parseAgyTranscriptLine('')).toBeNull()
    expect(parseAgyTranscriptLine('  ')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseAgyTranscriptLine('not json')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseAgyTranscriptLine('"just a string"')).toBeNull()
    expect(parseAgyTranscriptLine('[1,2,3]')).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(parseAgyTranscriptLine('{"foo": "bar"}')).toBeNull()
    expect(parseAgyTranscriptLine('{"step_index": "string-not-number"}')).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const step = parseAgyTranscriptLine(
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'VIEW_FILE' })
    )
    expect(step).toMatchObject({
      step_index: 1,
      source: 'MODEL',
      type: 'VIEW_FILE',
      status: '',
      created_at: '',
      content: ''
    })
  })
})

describe('projectAgyStepTools', () => {
  it('projects VIEW_FILE into tool_use + tool_result pair', () => {
    const step = makeStep({
      type: 'VIEW_FILE',
      content:
        'Created At: 2026-08-06T02:48:50+01:00\n' +
        'Completed At: 2026-08-06T02:48:50+01:00\n' +
        '\n' +
        'File Path: `file:///Users/chrisizatt/Documents/AGBench/src/main/index.ts`\n' +
        'Total Lines: 931\n' +
        'Total Bytes: 34702\n' +
        'Showing lines 90 to 170\n'
    })
    const events = projectAgyStepTools(step)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      tool_id: 'agy-view_file-3',
      tool_name: 'view_file',
      parameters: { path: 'file:///Users/chrisizatt/Documents/AGBench/src/main/index.ts' }
    })
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      tool_id: 'agy-view_file-3',
      tool_name: 'view_file',
      status: 'success'
    })
    expect(events[1].output).toContain('file:///Users/chrisizatt/Documents/AGBench/src/main/index.ts')
    expect(events[1].output).toContain('lines 90-170 of 931')
  })

  it('projects GREP_SEARCH into tool_use + tool_result pair', () => {
    const step = makeStep({
      type: 'GREP_SEARCH',
      content: [
        'Created At: 2026-08-06T02:48:49+01:00',
        'Completed At: 2026-08-06T02:48:49+01:00',
        '{"File":"/repo/src/a.ts","LineNumber":147,"LineContent":"  export function foo() {"}',
        '{"File":"/repo/src/b.ts","LineNumber":208,"LineContent":"  import { foo } from"}'
      ].join('\n')
    })
    const events = projectAgyStepTools(step)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      tool_id: 'agy-grep_search-3',
      tool_name: 'grep_search'
    })
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      status: 'success',
      output: '2 match(es)'
    })
  })

  it('reports "No results found" for empty grep', () => {
    const step = makeStep({
      type: 'GREP_SEARCH',
      content: 'Created At: 2026-08-06T02:48:44+01:00\nCompleted At: 2026-08-06T02:48:45+01:00\nNo results found'
    })
    const events = projectAgyStepTools(step)
    expect(events[1].output).toBe('No results found')
  })

  it('projects LIST_DIRECTORY into tool_use + tool_result pair', () => {
    const step = makeStep({
      type: 'LIST_DIRECTORY',
      content:
        'Created At: 2026-08-06T02:48:48+01:00\n' +
        'Completed At: 2026-08-06T02:48:48+01:00\n' +
        '{"name":"index.ts", "sizeBytes":"1234"}\n' +
        '{"name":"utils.ts", "sizeBytes":"5678"}\n' +
        '{"name":"types.ts", "sizeBytes":"90"}\n'
    })
    const events = projectAgyStepTools(step)
    expect(events).toHaveLength(2)
    expect(events[1].output).toBe('3 entries')
  })

  it('projects ERROR_MESSAGE as error-status tool_result', () => {
    const step = makeStep({
      type: 'ERROR_MESSAGE',
      content: 'Failed to read file: permission denied'
    })
    const events = projectAgyStepTools(step)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      tool_id: 'agy-error_message-3',
      status: 'error',
      output: 'Failed to read file: permission denied'
    })
  })

  it('skips RUN_COMMAND (covered by PreToolUse bridge)', () => {
    const step = makeStep({ type: 'RUN_COMMAND', content: 'git status' })
    expect(projectAgyStepTools(step)).toEqual([])
  })

  it('skips CODE_ACTION (covered by PreToolUse bridge)', () => {
    const step = makeStep({ type: 'CODE_ACTION', content: 'edit' })
    expect(projectAgyStepTools(step)).toEqual([])
  })

  it('skips PLANNER_RESPONSE (not a tool)', () => {
    const step = makeStep({ type: 'PLANNER_RESPONSE', content: '...' })
    expect(projectAgyStepTools(step)).toEqual([])
  })

  it('skips system-sourced steps', () => {
    const step = makeStep({ source: 'SYSTEM', type: 'VIEW_FILE' })
    expect(projectAgyStepTools(step)).toEqual([])
  })

  it('skips user-sourced steps', () => {
    const step = makeStep({ source: 'USER_EXPLICIT', type: 'VIEW_FILE' })
    expect(projectAgyStepTools(step)).toEqual([])
  })
})

describe('projectAgyTranscriptTools', () => {
  it('projects all tool steps from a complete transcript', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '', content: '' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '', content: 'thinking...' }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '', content: 'File Path: `/a.ts`\nTotal Lines: 10' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GREP_SEARCH', status: 'DONE', created_at: '', content: 'No results found' }),
      JSON.stringify({ step_index: 4, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '', content: 'npm test' }),
      JSON.stringify({ step_index: 5, source: 'MODEL', type: 'LIST_DIRECTORY', status: 'DONE', created_at: '', content: '{"name":"x.ts"}\n' })
    ]
    const events = projectAgyTranscriptTools(lines)
    // RUN_COMMAND skipped (bridge), USER_INPUT skipped, PLANNER_RESPONSE skipped
    // VIEW_FILE + GREP_SEARCH + LIST_DIRECTORY = 3 pairs = 6 events
    expect(events).toHaveLength(6)
    expect(events[0]).toMatchObject({ type: 'tool_use', tool_name: 'view_file' })
    expect(events[1]).toMatchObject({ type: 'tool_result', tool_name: 'view_file' })
    expect(events[2]).toMatchObject({ type: 'tool_use', tool_name: 'grep_search' })
    expect(events[3]).toMatchObject({ type: 'tool_result', tool_name: 'grep_search' })
    expect(events[4]).toMatchObject({ type: 'tool_use', tool_name: 'list_directory' })
    expect(events[5]).toMatchObject({ type: 'tool_result', tool_name: 'list_directory' })
  })

  it('returns empty array for transcript with no tools', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '', content: '' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '', content: '' })
    ]
    expect(projectAgyTranscriptTools(lines)).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(projectAgyTranscriptTools([])).toEqual([])
  })
})
