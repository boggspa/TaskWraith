import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from './store/types'
import { buildProviderShellRoutingPrompt } from './ProviderShellRoutingPrompt'

function permissions(
  shellCommands: EffectiveRunPermissions['agenticServices']['shellCommands'],
  mcpTools: EffectiveRunPermissions['agenticServices']['mcpTools'] = 'allow'
): Pick<EffectiveRunPermissions, 'agenticServices'> {
  return {
    agenticServices: { shellCommands, mcpTools } as EffectiveRunPermissions['agenticServices']
  }
}

describe('buildProviderShellRoutingPrompt', () => {
  it('routes a granted Grok shell operation through the governed MCP tool', () => {
    const prompt = buildProviderShellRoutingPrompt({
      provider: 'grok',
      effectivePermissions: permissions('allow')
    })

    expect(prompt).toContain('TaskWraith__run_shell_command')
    expect(prompt).toContain('already allowed shell commands')
    expect(prompt).toContain('Opaque process side effects')
    expect(prompt).toContain('permissionRetry')
    expect(prompt).toContain('capability gateway')
    expect(prompt).toContain('outside the workspace sandbox')
  })

  it("uses Cursor's broker alias and explains that ask opens user approval", () => {
    const prompt = buildProviderShellRoutingPrompt({
      provider: 'cursor',
      effectivePermissions: permissions('ask')
    })

    expect(prompt).toContain('taskwraith__run_shell_command')
    expect(prompt).toContain('normal user approval request')
    expect(prompt).toContain('native Shell/Write remain available')
  })

  it('does not advertise a managed shell reroute when either governing service is denied', () => {
    expect(
      buildProviderShellRoutingPrompt({
        provider: 'grok',
        effectivePermissions: permissions('deny')
      })
    ).toBe('')
    expect(
      buildProviderShellRoutingPrompt({
        provider: 'grok',
        effectivePermissions: permissions('allow', 'deny')
      })
    ).toBe('')
  })

  it('keeps Cursor sandbox continuity when MCP tools are denied', () => {
    const prompt = buildProviderShellRoutingPrompt({
      provider: 'cursor',
      effectivePermissions: permissions('allow', 'deny')
    })

    expect(prompt).toContain('native Shell/Write remain available')
    expect(prompt).not.toContain('taskwraith__run_shell_command')
  })

  it('advertises Pi direct shell and permission-request tools', () => {
    const prompt = buildProviderShellRoutingPrompt({
      provider: 'pi',
      effectivePermissions: permissions('workspace', 'deny')
    })

    expect(prompt).toContain('`run_shell_command`')
    expect(prompt).toContain('`request_tool_permission`')
    expect(prompt).not.toContain('TaskWraith__run_shell_command')
  })
})
