import { describe, expect, it } from 'vitest'

import { providerRunRequiresCoarseWorkspaceLock } from './WorkspaceLockProviderPolicy'

function run(
  provider: Parameters<typeof providerRunRequiresCoarseWorkspaceLock>[0]['provider'],
  overrides: Partial<Parameters<typeof providerRunRequiresCoarseWorkspaceLock>[0]> = {}
): Parameters<typeof providerRunRequiresCoarseWorkspaceLock>[0] {
  return {
    provider,
    scope: 'workspace',
    workspace: '/workspace',
    approvalMode: 'default',
    ...overrides
  }
}

describe('providerRunRequiresCoarseWorkspaceLock', () => {
  it('does not serialize Kimi runs whose writes are already broker-only', () => {
    expect(providerRunRequiresCoarseWorkspaceLock(run('kimi'))).toBe(false)
    expect(providerRunRequiresCoarseWorkspaceLock(run('kimi', { approvalMode: 'auto_edit' }))).toBe(
      false
    )
  })

  it('retains coarse fallback for opaque or nontransactional native writers', () => {
    expect(providerRunRequiresCoarseWorkspaceLock(run('claude', { approvalMode: 'plan' }))).toBe(
      true
    )
    expect(providerRunRequiresCoarseWorkspaceLock(run('grok'))).toBe(true)
    expect(providerRunRequiresCoarseWorkspaceLock(run('grok', { approvalMode: 'plan' }))).toBe(
      false
    )
    expect(providerRunRequiresCoarseWorkspaceLock(run('cursor'))).toBe(true)
    expect(providerRunRequiresCoarseWorkspaceLock(run('pi'))).toBe(true)
  })

  it('keeps brokered API lanes and non-workspace runs out of coarse authority', () => {
    expect(
      providerRunRequiresCoarseWorkspaceLock(
        run('antigravity', { model: 'gemini-api:gemini-2.5-pro' })
      )
    ).toBe(false)
    expect(providerRunRequiresCoarseWorkspaceLock(run('ollama'))).toBe(false)
    expect(
      providerRunRequiresCoarseWorkspaceLock(
        run('codex', { scope: 'global', workspace: undefined })
      )
    ).toBe(false)
  })
})
