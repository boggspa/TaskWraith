import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../main/store/types'

import {
  extractToolInvocationParameters,
  isMcpTransportWrapperActivity,
  mergeToolResultParameters,
  presentToolInvocation
} from './toolInvocationPresentation'

function activity(overrides: Partial<ToolActivity>): ToolActivity {
  return {
    id: 'activity-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    ...overrides
  }
}

describe('tool invocation presentation', () => {
  it('identifies opaque MCP transport wrappers without hiding concrete MCP tools', () => {
    expect(
      isMcpTransportWrapperActivity(
        activity({ toolName: 'callMcpTool', displayName: 'Used callmcptool', category: 'unknown' })
      )
    ).toBe(true)
    expect(
      isMcpTransportWrapperActivity(
        activity({ toolName: 'mcp', displayName: 'MCP', category: 'unknown' })
      )
    ).toBe(true)
    expect(
      isMcpTransportWrapperActivity(
        activity({
          toolName: 'unknown',
          displayName: 'Used unknown',
          category: 'unknown',
          parameters: { mcpToolName: 'workspace_search', server: 'taskwraith' },
          rawUseEvent: { type: 'mcpToolCall', arguments: { query: 'needle' } }
        })
      )
    ).toBe(true)
    expect(
      isMcpTransportWrapperActivity(
        activity({
          toolName: 'mcp__taskwraith__read_file',
          displayName: 'Read file',
          parameters: { path: 'README.md', server: 'taskwraith' },
          rawUseEvent: { type: 'mcpToolCall' }
        })
      )
    ).toBe(false)
  })

  it('keeps command-shaped generic activities visible', () => {
    expect(
      isMcpTransportWrapperActivity(
        activity({
          toolName: 'mcp',
          displayName: 'MCP',
          category: 'unknown',
          parameters: { command: 'bash ./scripts/check.sh' }
        })
      )
    ).toBe(false)
    expect(
      isMcpTransportWrapperActivity(
        activity({
          toolName: 'unknown',
          displayName: 'Used unknown',
          category: 'unknown',
          rawUseEvent: {
            type: 'mcpToolCall',
            arguments: { command: 'rg needle src' }
          }
        })
      )
    ).toBe(false)
  })

  it('retains populated argument bags when another envelope bag is empty', () => {
    expect(
      extractToolInvocationParameters({
        parameters: {},
        arguments: { path: 'src/a.ts', old_string: 'old', new_string: 'new' }
      })
    ).toMatchObject({ path: 'src/a.ts', old_string: 'old', new_string: 'new' })
  })

  it('understands Cursor/ACP rawInput and OpenAI function JSON arguments', () => {
    expect(
      extractToolInvocationParameters({ rawInput: { path: 'src/a.ts', content: 'body' } })
    ).toMatchObject({ path: 'src/a.ts', content: 'body' })
    expect(
      extractToolInvocationParameters({
        function: { arguments: '{"path":"src/b.ts","old_string":"a","new_string":"b"}' }
      })
    ).toMatchObject({ path: 'src/b.ts', old_string: 'a', new_string: 'b' })
    expect(
      extractToolInvocationParameters({
        function: { args: { path: 'src/c.ts', content: 'body' } },
        toolInput: { ignored: true }
      })
    ).toMatchObject({ path: 'src/c.ts', content: 'body' })
    expect(
      extractToolInvocationParameters({ tool_input: { path: 'src/d.ts', content: 'body' } })
    ).toMatchObject({ path: 'src/d.ts', content: 'body' })
  })

  it('merges terminal change evidence without replacing the original write body', () => {
    expect(
      mergeToolResultParameters(
        { path: 'src/a.ts', content: 'source body' },
        { result: { changes: [{ path: 'src/a.ts', additions: 2, deletions: 1 }] }, content: 'done' }
      )
    ).toMatchObject({
      path: 'src/a.ts',
      content: 'source body',
      changes: [{ path: 'src/a.ts', additions: 2, deletions: 1 }]
    })
  })

  it('drops result output echoes from the parameters of a call that has input', () => {
    // Muse `exec --json` compat tool_result lines duplicate the whole output
    // string into `content` (and `output`); the un-scrubbed fold persisted a
    // read's entire file body inside `parameters` — tens of KB per row — and
    // handed the diff estimators output text to count.
    const merged = mergeToolResultParameters(
      { path: 'src/App.tsx' },
      {
        type: 'tool_result',
        tool_id: 'call_1',
        provider: 'muse',
        output: 'line 1\nline 2\nline 3',
        content: 'line 1\nline 2\nline 3'
      }
    )
    expect(merged).toMatchObject({ path: 'src/App.tsx' })
    expect(merged).not.toHaveProperty('content')
    expect(merged).not.toHaveProperty('output')
  })

  it('keeps the whole result root for a result-only call (no input arguments)', () => {
    // Result-only providers put the tool INPUT on the result event; the root
    // is then the only argument source, and a content-only write must still
    // light its `+N -0` row from it.
    expect(
      mergeToolResultParameters(undefined, {
        path: 'notes.md',
        content: 'one\ntwo\nthree'
      })
    ).toMatchObject({ path: 'notes.md', content: 'one\ntwo\nthree' })
    expect(
      mergeToolResultParameters(
        {},
        {
          path: 'notes.md',
          content: 'one\ntwo\nthree'
        }
      )
    ).toMatchObject({ path: 'notes.md', content: 'one\ntwo\nthree' })
  })

  it('keeps measured counts and patch evidence flowing while output text is scrubbed', () => {
    const merged = mergeToolResultParameters(
      { path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      {
        content: 'Edited src/a.ts',
        additions: 1,
        deletions: 1,
        diff: '@@ -1 +1 @@\n-a\n+b',
        kind: 'edit',
        status: 'success'
      }
    )
    expect(merged).toMatchObject({
      path: 'src/a.ts',
      additions: 1,
      deletions: 1,
      diff: '@@ -1 +1 @@\n-a\n+b',
      kind: 'edit'
    })
    expect(merged).not.toHaveProperty('content')
  })

  it('projects a valid capability invocation to its concrete target', () => {
    expect(
      presentToolInvocation('mcp__TaskWraith__capability_invoke', {
        name: 'replace',
        arguments: { path: 'src/a.ts', old_string: 'before', new_string: 'after' }
      })
    ).toEqual({
      toolName: 'replace',
      parameters: { path: 'src/a.ts', old_string: 'before', new_string: 'after' },
      viaCapabilityGateway: true
    })
  })

  it('keeps an invalid capability envelope visibly outer rather than guessing a target', () => {
    expect(
      presentToolInvocation('capability_invoke', {
        name: 'replace',
        input: { name: 'write_file', path: 'src/a.ts' }
      })
    ).toMatchObject({ toolName: 'capability_invoke', viaCapabilityGateway: false })
  })
})
