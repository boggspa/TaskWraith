import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AgenticServiceId, AgenticServicePolicy } from '../store/types'
import {
  buildExecutionGraphProviderInputManifest,
  freezeExecutionGraphProviderInput,
  MAX_EXECUTION_GRAPH_PROVIDER_INPUT_BYTES,
  verifyExecutionGraphProviderInputManifest
} from './ExecutionGraphProviderInput'

function payload(): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/workspace',
    prompt: 'Perform the exact step.',
    appRunId: 'run-one',
    appChatId: 'chat-one',
    model: 'gpt-5.6-sol',
    imagePaths: ['/tmp/page-1.png'],
    approvalMode: 'default',
    workflowMode: 'normal',
    providerSessionId: null,
    sessionTrust: false,
    taskWraithMcpProfileId: 'taskwraith-gateway-v1',
    taskWraithMcpAdvertised: true,
    effectivePermissions: {
      presetId: 'default',
      approvalMode: 'default',
      agenticServices: {} as Record<AgenticServiceId, AgenticServicePolicy>,
      networkAccess: 'deny',
      externalPathGrants: [],
      workspaceGrantServiceIds: [],
      readOnly: false,
    }
  }
}

describe('ExecutionGraphProviderInput', () => {
  it('binds prompt, attachments, runtime, and permission posture into one digest', () => {
    const original = payload()
    const manifest = buildExecutionGraphProviderInputManifest(original)

    expect(verifyExecutionGraphProviderInputManifest(original, manifest)).toBe(true)
    expect(
      verifyExecutionGraphProviderInputManifest(
        { ...original, prompt: 'Changed after admission.' },
        manifest
      )
    ).toBe(false)
    expect(
      verifyExecutionGraphProviderInputManifest(
        { ...original, imagePaths: ['/tmp/page-2.png'] },
        manifest
      )
    ).toBe(false)
    expect(
      verifyExecutionGraphProviderInputManifest(
        { ...original, taskWraithMcpAdvertised: false },
        manifest
      )
    ).toBe(false)
  })

  it('deep-freezes the exact payload before adapter observation', () => {
    const original = payload()
    freezeExecutionGraphProviderInput(original)

    expect(Object.isFrozen(original)).toBe(true)
    expect(Object.isFrozen(original.imagePaths)).toBe(true)
    expect(Object.isFrozen(original.effectivePermissions)).toBe(true)
    expect(Object.isFrozen(original.effectivePermissions?.agenticServices)).toBe(true)
    expect(() => {
      original.prompt = 'mutated'
    }).toThrow()
  })

  it('rejects oversized provider authority records', () => {
    expect(() =>
      buildExecutionGraphProviderInputManifest({
        ...payload(),
        prompt: 'x'.repeat(MAX_EXECUTION_GRAPH_PROVIDER_INPUT_BYTES + 1)
      })
    ).toThrow(/authority limit/)
  })
})
