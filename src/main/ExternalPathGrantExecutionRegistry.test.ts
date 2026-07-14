import { describe, expect, it } from 'vitest'
import { ExternalPathGrantExecutionRegistry } from './ExternalPathGrantExecutionRegistry'
import type { ExternalPathGrant } from './store/types'

function grant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-a',
    provider: 'codex',
    bindingVersion: 2,
    workspaceId: 'workspace-a',
    chatId: 'chat-a',
    appRunId: 'run-a',
    path: '/outside/repository',
    kind: 'directory',
    access: 'write',
    duration: 'thisRun',
    issuedBy: 'main',
    signature: 'signature-a',
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides
  }
}

describe('ExternalPathGrantExecutionRegistry', () => {
  it('allows only thisRun grants issued during the current process epoch', () => {
    const issued = grant()
    const registry = new ExternalPathGrantExecutionRegistry()
    expect(registry.allowsExecution(issued)).toBe(false)

    registry.registerIssued(issued)
    expect(registry.allowsExecution(issued)).toBe(true)
    expect(registry.allowsExecution({ ...issued, signature: 'replayed-signature' })).toBe(false)
    expect(registry.allowsExecution({ ...issued, appRunId: 'run-b' })).toBe(false)

    const restartedRegistry = new ExternalPathGrantExecutionRegistry()
    expect(restartedRegistry.allowsExecution(issued)).toBe(false)
  })

  it('does not treat malformed issuance as live and can revoke a completed run', () => {
    const registry = new ExternalPathGrantExecutionRegistry()
    registry.registerIssued(grant({ appRunId: undefined }))
    registry.registerIssued(grant({ bindingVersion: undefined }))
    expect(registry.allowsExecution(grant())).toBe(false)

    registry.registerIssued(grant())
    registry.revokeRun('run-a')
    expect(registry.allowsExecution(grant())).toBe(false)
  })

  it('leaves durable thisThread grants to canonical membership checks', () => {
    const registry = new ExternalPathGrantExecutionRegistry()
    expect(
      registry.allowsExecution(
        grant({ duration: 'thisThread', appRunId: undefined, signature: 'thread-signature' })
      )
    ).toBe(true)
  })
})
