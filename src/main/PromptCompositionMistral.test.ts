// Prompt-composition behaviour for the Mistral Vibe ACP seat.
//
// Kept in its own file rather than added to PromptComposition.test.ts because
// every gap covered here is SILENT: PromptComposition.ts contains no
// provider-keyed Record, no exhaustive switch and no `never` check, so adding
// 'mistral' to ProviderId produced zero compile errors and zero test failures
// while the seat quietly received none of the right behaviour. These are the
// assertions that would have failed.

import { describe, expect, it } from 'vitest'
import { TASKWRAITH_RUNTIME_PREAMBLE_VERSION, composeRunPrompt } from './PromptComposition'
import { TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID } from './mcp/McpSessionProfileFence'
import type { ChatMessage } from './store/types'

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id || 'm',
    role: overrides.role || 'user',
    content: overrides.content || '',
    timestamp: overrides.timestamp || '2026-07-26T12:00:00Z',
    ...overrides
  } as ChatMessage
}

const priorTurns: ChatMessage[] = [
  message({ id: 'm1', role: 'user', content: 'Rename the byte pin to spark_pin.' }),
  message({ id: 'm2', role: 'assistant', content: 'Renamed it across three files.' })
]

function composeMistral(overrides: Record<string, unknown> = {}) {
  return composeRunPrompt({
    instructionContext: null,
    provider: 'mistral',
    finalPrompt: 'Now update the docs to match.',
    messages: priorTurns,
    chatContextTurns: 6,
    codexHandoffsApplied: [],
    isGlobalRun: false,
    approvalMode: 'default',
    providerLabel: 'Mistral',
    taskWraithMcpAdvertised: true,
    ...overrides
  })
}

describe('composeRunPrompt — Mistral cross-turn context', () => {
  it('re-injects the transcript because the Vibe lane opens a fresh session each turn', () => {
    const result = composeMistral()
    expect(result.contextualPrompt).toContain('Conversation context')
    expect(result.contextualPrompt).toContain('Rename the byte pin to spark_pin.')
    expect(result.contextualPrompt).toContain(
      'Current user request:\nNow update the docs to match.'
    )
    expect(result.contextTurnsApplied).toBeGreaterThan(0)
  })

  it('still re-injects when a provider session id is present', () => {
    // Vibe DOES advertise loadSession:true and implements session/load, unlike
    // Grok — so a stored session id is not evidence of a resumable turn here.
    // Our lane never calls session/load, so honouring the id would produce a
    // context-blind turn that merely LOOKS resumed. This is the regression that
    // would appear if `mistralNeedsContextInjection` were ever gated on
    // `!resumeSessionId` to match gemini/codex.
    const resumed = composeMistral({ resumeSessionId: 'vibe-session-abc' })
    expect(resumed.contextualPrompt).toContain('Rename the byte pin to spark_pin.')
    expect(resumed.contextTurnsApplied).toBeGreaterThan(0)
  })

  it('does not claim provider-side history is authoritative in the application log', () => {
    const result = composeMistral()
    // The pre-fix fallthrough logged "Context turns: 0 (Mistral provider/session
    // history is authoritative when available)" — false for this lane, and the
    // exact line a debugger would trust while chasing cross-turn amnesia.
    expect(result.applicationLog).not.toContain('history is authoritative')
    expect(result.applicationLog).toContain('Mistral')
    expect(result.applicationLog).toContain('fresh session each turn')
  })

  it('carries the prior-session compaction summary above the recent transcript', () => {
    const result = composeMistral({
      contextCompactionSummary: {
        text: 'Earlier: migrated the pin table off the legacy schema.',
        createdAt: '2026-07-26T11:00:00Z'
      }
    })
    expect(result.contextualPrompt).toContain('Prior session summary')
    expect(result.contextualPrompt).toContain('migrated the pin table off the legacy schema')
    expect(result.contextualPrompt.indexOf('Prior session summary')).toBeLessThan(
      result.contextualPrompt.indexOf('Now update the docs to match.')
    )
  })
})

describe('composeRunPrompt — Mistral runtime preamble', () => {
  it('injects the runtime preamble and names the provider Mistral', () => {
    const result = composeMistral()
    expect(result.contextualPrompt).toContain(TASKWRAITH_RUNTIME_PREAMBLE_VERSION)
    // The providerDisplayName fallthrough rendered this as "this Sub-thread
    // workspace run" — plausible-looking enough to survive eyeballing, which is
    // exactly why it is asserted rather than reviewed.
    expect(result.contextualPrompt).toContain('this Mistral workspace run')
    expect(result.contextualPrompt).not.toContain('this Sub-thread workspace run')
    expect(result.runtimePreambleVersion).toBe(TASKWRAITH_RUNTIME_PREAMBLE_VERSION)
    expect(result.runtimePreambleProvider).toBe('mistral')
  })

  it('injects the preamble on EVERY turn, not just a cold one', () => {
    // Mistral belongs to the unconditional group (kimi-cold/grok/cursor), not
    // the resume-aware group (gemini/claude/codex): there is no provider-side
    // memory of the preamble to rely on when every turn is a fresh session.
    const resumed = composeMistral({
      resumeSessionId: 'vibe-session-abc',
      runtimePreambleVersion: TASKWRAITH_RUNTIME_PREAMBLE_VERSION,
      runtimePreambleProvider: 'mistral'
    })
    expect(resumed.contextualPrompt).toContain(TASKWRAITH_RUNTIME_PREAMBLE_VERSION)
  })

  it('uses the unprefixed TaskWraith delegate tool name', () => {
    const result = composeMistral({
      taskWraithMcpProfileId: TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID
    })
    expect(result.contextualPrompt).toContain('TaskWraith__delegate_to_subthread')
    expect(result.contextualPrompt).toContain('TaskWraith__delegate_wave')
    expect(result.contextualPrompt).not.toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(result.contextualPrompt).not.toContain('mcp__TaskWraith__delegate_wave')
  })

  it('suppresses the preamble in plan mode and on a global run', () => {
    expect(composeMistral({ approvalMode: 'plan' }).contextualPrompt).not.toContain(
      TASKWRAITH_RUNTIME_PREAMBLE_VERSION
    )
    expect(composeMistral({ isGlobalRun: true }).contextualPrompt).not.toContain(
      TASKWRAITH_RUNTIME_PREAMBLE_VERSION
    )
  })

  it('omits the preamble when the TaskWraith MCP server is not advertised', () => {
    const result = composeMistral({ taskWraithMcpAdvertised: false })
    expect(result.contextualPrompt).not.toContain(TASKWRAITH_RUNTIME_PREAMBLE_VERSION)
    // Context injection is independent of MCP advertisement and must survive.
    expect(result.contextualPrompt).toContain('Rename the byte pin to spark_pin.')
  })
})
