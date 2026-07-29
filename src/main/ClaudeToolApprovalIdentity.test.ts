import { describe, expect, it } from 'vitest'
import {
  normalizeClaudeCanUseToolArgs,
  resolveClaudeToolApprovalIdentity
} from './ClaudeToolApprovalIdentity'

describe('resolveClaudeToolApprovalIdentity', () => {
  it('recognizes only exact declared TaskWraith MCP routes', () => {
    expect(
      resolveClaudeToolApprovalIdentity('mcp__TaskWraith__write_file', {
        path: 'src/file.ts',
        content: 'body'
      })
    ).toMatchObject({
      kind: 'taskwraith-mcp',
      contract: {
        toolName: 'write_file',
        effectiveToolName: 'write_file',
        service: 'fileChanges'
      }
    })
    expect(
      resolveClaudeToolApprovalIdentity('mcp__TaskWraith__capability_invoke', {
        name: 'read_file',
        arguments: { path: 'README.md' }
      })
    ).toMatchObject({
      kind: 'taskwraith-mcp',
      contract: {
        toolName: 'capability_invoke',
        effectiveToolName: 'read_file'
      }
    })
  })

  it('denies unknown and contradictory identities in the reserved namespace', () => {
    for (const [toolName, args] of [
      ['mcp__TaskWraith__unknown_tool', {}],
      ['TaskWraith__mcp__evil__write_file', {}],
      [
        'mcp__TaskWraith__capability_invoke',
        { name: 'write_file', input: { name: 'mcp__evil__write_file' } }
      ]
    ] as const) {
      expect(resolveClaudeToolApprovalIdentity(toolName, args), toolName).toMatchObject({
        kind: 'invalid-taskwraith-mcp'
      })
    }
  })

  it('keeps foreign MCP identities generic even when their tail is privileged', () => {
    for (const toolName of [
      'mcp__evil__write_file',
      'mcp__evil__canvas_eval',
      'mcp__evil__tw_recall_read',
      'mcp__evil__ensemble_roster_edit',
      'mcp__evil__task'
    ]) {
      expect(resolveClaudeToolApprovalIdentity(toolName), toolName).toEqual({
        kind: 'foreign-mcp'
      })
    }
  })

  it('does not reinterpret bare native names as TaskWraith catalog identity', () => {
    for (const toolName of ['read_file', 'write_file', 'Task', 'WebSearch']) {
      expect(resolveClaudeToolApprovalIdentity(toolName), toolName).toEqual({
        kind: 'provider-native'
      })
    }
  })

  it('rejects contradictory object-form stable identities before precedence can choose one', () => {
    expect(
      normalizeClaudeCanUseToolArgs({
        toolName: 'mcp__TaskWraith__read_file',
        name: 'mcp__evil__read_file',
        input: { path: 'README.md' }
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/contradictory/i)
    })
    expect(
      normalizeClaudeCanUseToolArgs({
        toolName: 'mcp__TaskWraith__read_file',
        tool_name: 'mcp__TaskWraith__read_file',
        input: { path: 'README.md' }
      })
    ).toEqual({
      ok: true,
      toolName: 'mcp__TaskWraith__read_file',
      input: { path: 'README.md' }
    })
  })
})
