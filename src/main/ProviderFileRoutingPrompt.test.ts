import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from './store/types'
import {
  buildProviderFileRoutingPrompt,
  stripProviderFileRoutingPromptPrefix
} from './ProviderFileRoutingPrompt'

function permissions(
  fileChanges: EffectiveRunPermissions['agenticServices']['fileChanges'],
  mcpTools: EffectiveRunPermissions['agenticServices']['mcpTools'] = 'allow'
): Pick<EffectiveRunPermissions, 'agenticServices'> {
  return {
    agenticServices: { fileChanges, mcpTools } as EffectiveRunPermissions['agenticServices']
  }
}

describe('buildProviderFileRoutingPrompt', () => {
  it('routes a granted Codex edit through the exact TaskWraith patch tool', () => {
    const prompt = buildProviderFileRoutingPrompt({
      provider: 'codex',
      effectivePermissions: permissions('allow')
    })

    expect(prompt).toContain('TaskWraith__apply_patch')
    expect(prompt).toContain('TaskWraith__write_file')
    expect(prompt).toContain('already allowed in-workspace file changes')
    expect(prompt).toContain('read-only sandbox')
    expect(prompt).toContain('does not cancel the effective TaskWraith file grant')
    expect(prompt).toContain('approved lane scope')
  })

  it('routes a granted Cursor edit through its brokered TaskWraith tools', () => {
    const prompt = buildProviderFileRoutingPrompt({
      provider: 'cursor',
      effectivePermissions: permissions('allow')
    })

    expect(prompt).toContain('taskwraith__apply_patch')
    expect(prompt).toContain('taskwraith__write_file')
    expect(prompt).toContain('Cursor-native apply_patch/edit/write tool')
    expect(prompt).toContain('TaskWraith locks, audit, and grants')
  })

  it('explains normal approval for a Codex ask posture', () => {
    const prompt = buildProviderFileRoutingPrompt({
      provider: 'codex',
      effectivePermissions: permissions('ask')
    })

    expect(prompt).toContain('TaskWraith__apply_patch')
    expect(prompt).toContain('normal user approval request')
  })

  it('does not advertise a file route when either governing service is denied', () => {
    expect(
      buildProviderFileRoutingPrompt({
        provider: 'codex',
        effectivePermissions: permissions('deny')
      })
    ).toBe('')
    expect(
      buildProviderFileRoutingPrompt({
        provider: 'codex',
        effectivePermissions: permissions('allow', 'deny')
      })
    ).toBe('')
  })

  it('does not add the broker route to providers without Cursor-style dual surfaces', () => {
    for (const provider of [
      'claude',
      'gemini',
      'kimi',
      'ollama',
      'grok',
      'mistral',
      'antigravity',
      'pi',
      'muse'
    ] as const) {
      expect(
        buildProviderFileRoutingPrompt({
          provider,
          effectivePermissions: permissions('allow')
        })
      ).toBe('')
    }
  })

  it('strips only the generated leading envelope', () => {
    const envelope = buildProviderFileRoutingPrompt({
      provider: 'codex',
      effectivePermissions: permissions('allow')
    })
    const quoted = '<taskwraith-file-routing-v1>quoted</taskwraith-file-routing-v1>'

    expect(stripProviderFileRoutingPromptPrefix(`${envelope}Work.\n${quoted}`)).toBe(
      `Work.\n${quoted}`
    )
    expect(stripProviderFileRoutingPromptPrefix(`Work.\n${quoted}`)).toBe(`Work.\n${quoted}`)
  })
})
