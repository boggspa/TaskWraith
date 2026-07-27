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
    expect(prompt).toContain('supersedes generic “do not retry through another tool”')
  })

  it("uses Cursor's broker alias and explains that ask opens user approval", () => {
    const prompt = buildProviderShellRoutingPrompt({
      provider: 'cursor',
      effectivePermissions: permissions('ask')
    })

    expect(prompt).toContain('taskwraith__run_shell_command')
    expect(prompt).toContain('normal user approval request')
  })

  it('does not advertise a shell reroute when either governing service is denied', () => {
    expect(
      buildProviderShellRoutingPrompt({
        provider: 'grok',
        effectivePermissions: permissions('deny')
      })
    ).toBe('')
    expect(
      buildProviderShellRoutingPrompt({
        provider: 'cursor',
        effectivePermissions: permissions('allow', 'deny')
      })
    ).toBe('')
  })
})
