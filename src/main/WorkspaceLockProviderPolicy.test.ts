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
  it('never turns provider or participant dispatch into a workspace mutation', () => {
    for (const provider of [
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'mistral',
      'pi',
      'ollama',
      'antigravity'
    ] as const) {
      expect(providerRunRequiresCoarseWorkspaceLock(run(provider))).toBe(false)
      expect(providerRunRequiresCoarseWorkspaceLock(run(provider, { approvalMode: 'plan' }))).toBe(
        false
      )
    }
    expect(
      providerRunRequiresCoarseWorkspaceLock(
        run('codex', { scope: 'global', workspace: undefined })
      )
    ).toBe(false)
  })
})
