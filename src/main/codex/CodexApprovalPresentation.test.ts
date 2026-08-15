import { describe, expect, it } from 'vitest'
import { codexShellApprovalPresentation } from './CodexApprovalPresentation'

describe('codexShellApprovalPresentation', () => {
  it('lifts the exact nested MCP command and cwd into the visible preview', () => {
    const params = {
      serverName: 'TaskWraith',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_params: {
          cwd: '/workspace',
          command: 'git branch --show-current && git rev-parse HEAD'
        }
      }
    }

    expect(
      codexShellApprovalPresentation(params, {
        kind: 'tool',
        toolName: 'run_shell_command',
        params,
        actions: ['accept', 'decline']
      })
    ).toEqual({
      title: 'Approve Codex shell command',
      body: 'git branch --show-current && git rev-parse HEAD\n/workspace',
      preview: {
        kind: 'command',
        toolName: 'run_shell_command',
        params,
        actions: ['accept', 'decline'],
        command: 'git branch --show-current && git rev-parse HEAD',
        cwd: '/workspace'
      }
    })
  })

  it('normalizes native argv while preserving existing presentation fields', () => {
    expect(
      codexShellApprovalPresentation(
        { command: ['git', 'status', '--short'], cwd: '/repo' },
        { kind: 'tool', riskLabels: ['workspace'] }
      )
    ).toMatchObject({
      body: 'git status --short\n/repo',
      preview: {
        kind: 'command',
        command: 'git status --short',
        cwd: '/repo',
        riskLabels: ['workspace']
      }
    })
  })

  it('does not infer a command from display prose or malformed metadata', () => {
    expect(
      codexShellApprovalPresentation(
        { message: 'Allow run_shell_command to run git status?' },
        { kind: 'tool' }
      )
    ).toBeNull()
    expect(codexShellApprovalPresentation(null, null)).toBeNull()
  })
})
