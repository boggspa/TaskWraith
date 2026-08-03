import { describe, expect, it } from 'vitest'
import {
  grokTaskWraithBrokerToolRequested,
  grokTaskWraithSafeToolRequested,
  resolveStructuredTaskWraithToolRequest,
  shouldAdvertiseTaskWraithMcpToGrok,
  structuredProviderNetworkAccessAllowed,
  structuredProviderNetworkReadRequested,
  structuredTaskWraithSafeToolRequested
} from './GrokMcpAdvertise'

describe('grokTaskWraithSafeToolRequested', () => {
  it('allows the TaskWraith-qualified ask_user_question request emitted by Grok ACP', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          rawInput: { tool_name: 'TaskWraith__ask_user_question' }
        }
      })
    ).toBe(true)
  })

  it('still unqualifies the legacy taskwraith-broker alias for safe tools', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          rawInput: { tool_name: 'taskwraith-broker__ask_user_question' }
        }
      })
    ).toBe(true)
  })

  it('retains the configured read-only scoped namespace', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          kind: 'read',
          rawInput: { tool_name: 'taskwraith-grok__read_file' }
        }
      })
    ).toBe(true)
  })

  it('never treats an ACP human title as broker provenance', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'taskwraith-grok__read_file',
        toolKind: 'edit',
        rawToolCall: {
          title: 'taskwraith-grok__read_file',
          kind: 'edit',
          rawInput: { path: '../outside.txt', content: 'owned' }
        }
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'taskwraith-broker__read_file',
        rawToolCall: {
          title: 'taskwraith-broker__read_file',
          kind: 'edit',
          rawInput: { path: '../outside.txt', content: 'owned' }
        }
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        toolName: 'TaskWraith__read_file',
        rawToolCall: {
          title: 'TaskWraith__read_file',
          kind: 'edit',
          rawInput: { path: '../outside.txt', content: 'owned' }
        }
      })
    ).toBe(false)
  })

  it('rejects a stable safe-tool alias that contradicts a mutating ACP kind', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        toolKind: 'edit',
        rawToolCall: {
          kind: 'edit',
          rawInput: {
            tool_name: 'taskwraith-grok__read_file',
            path: '../outside.txt',
            content: 'owned'
          }
        }
      })
    ).toBe(false)
  })

  it('applies the same stable-identity rule to Mistral namespaces', () => {
    const request = {
      toolName: 'display title',
      toolKind: 'read',
      rawToolCall: {
        kind: 'read',
        rawInput: { tool_name: 'taskwraith-mistral__read_file', path: 'README.md' }
      }
    }
    expect(
      structuredTaskWraithSafeToolRequested(request, [
        'taskwraith-mistral',
        'taskwraith-broker',
        'TaskWraith'
      ])
    ).toBe(true)
    expect(
      structuredTaskWraithSafeToolRequested(
        {
          ...request,
          toolKind: 'edit',
          rawToolCall: {
            kind: 'edit',
            rawInput: {
              tool_name: 'taskwraith-mistral__read_file',
              path: '../outside.txt',
              content: 'owned'
            }
          }
        },
        ['taskwraith-mistral', 'taskwraith-broker', 'TaskWraith']
      )
    ).toBe(false)
  })

  // The gateway's own `name` argument is the TARGET being invoked, not a competing
  // identity. The 1.9.2 snapshot counted it as one, which made the identity-
  // agreement check unsatisfiable for every capability_invoke call and denied the
  // gateway outright on read-only Grok/Mistral seats.
  it('classifies capability_invoke as safe even though its target argument differs', () => {
    expect(
      structuredTaskWraithSafeToolRequested(
        {
          toolName: 'display title',
          toolKind: 'read',
          rawToolCall: {
            kind: 'read',
            rawInput: {
              tool_name: 'taskwraith-broker__capability_invoke',
              name: 'read_file',
              arguments: { path: 'README.md' }
            }
          }
        },
        ['taskwraith', 'taskwraith-broker', 'TaskWraith']
      )
    ).toBe(true)
  })

  it('resolves Grok ACP use_tool envelopes whose invocation lives under tool_input', () => {
    const request = {
      toolName: 'use_tool',
      rawToolCall: {
        title: 'use_tool',
        rawInput: {
          tool_name: 'TaskWraith__capability_invoke',
          tool_input: {
            name: 'request_tool_permission',
            arguments: {
              tool_name: 'run_shell_command',
              arguments: { command: 'npm run test', cwd: '.' },
              failure: 'opaque process side effects'
            }
          }
        }
      }
    }

    expect(grokTaskWraithBrokerToolRequested(request)).toBe(true)
    expect(
      resolveStructuredTaskWraithToolRequest(request, [
        'taskwraith-grok',
        'taskwraith-broker',
        'TaskWraith'
      ])
    ).toMatchObject({
      toolName: 'capability_invoke',
      effectiveToolName: 'request_tool_permission'
    })
  })

  it('fails closed when root and nested gateway targets disagree', () => {
    expect(
      grokTaskWraithBrokerToolRequested({
        toolName: 'use_tool',
        rawToolCall: {
          rawInput: {
            tool_name: 'TaskWraith__capability_invoke',
            name: 'read_file',
            tool_input: {
              name: 'request_tool_permission',
              arguments: {}
            }
          }
        }
      })
    ).toBe(false)
  })

  it('still refuses a NON-gateway envelope whose rawInput.name contradicts it', () => {
    expect(
      structuredTaskWraithSafeToolRequested(
        {
          toolName: 'display title',
          toolKind: 'read',
          rawToolCall: {
            kind: 'read',
            rawInput: {
              tool_name: 'taskwraith-broker__read_file',
              name: 'taskwraith-broker__write_file',
              path: 'README.md'
            }
          }
        },
        ['taskwraith', 'taskwraith-broker', 'TaskWraith']
      )
    ).toBe(false)
  })

  it('fails closed for mutating tools and unrecognized namespaces', () => {
    expect(
      grokTaskWraithSafeToolRequested({
        rawToolCall: { rawInput: { tool_name: 'TaskWraith__write_file' } }
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        rawToolCall: { rawInput: { tool_name: 'taskwraith-broker__write_file' } }
      })
    ).toBe(false)
    expect(
      grokTaskWraithSafeToolRequested({
        rawToolCall: { rawInput: { tool_name: 'other-broker__ask_user_question' } }
      })
    ).toBe(false)
  })

  it('recognizes an exact mutating broker call without treating its title as authority', () => {
    const request = {
      toolName: 'Edit a file',
      toolKind: 'edit',
      rawToolCall: {
        kind: 'edit',
        rawInput: {
          tool_name: 'taskwraith-grok__write_file',
          path: 'src/a.ts',
          content: 'next'
        }
      }
    }
    expect(grokTaskWraithBrokerToolRequested(request)).toBe(true)
    expect(grokTaskWraithSafeToolRequested(request)).toBe(false)
    expect(
      resolveStructuredTaskWraithToolRequest(request, [
        'taskwraith-grok',
        'taskwraith-broker',
        'TaskWraith'
      ])
    ).toMatchObject({ toolName: 'write_file' })
  })
})

describe('structuredProviderNetworkReadRequested', () => {
  it('ignores network-looking ACP titles on native writes for both providers', () => {
    for (const provider of ['grok', 'mistral'] as const) {
      expect(
        structuredProviderNetworkReadRequested(provider, {
          toolName: 'Web Search',
          toolKind: 'edit',
          rawToolCall: {
            kind: 'edit',
            rawInput: { path: 'src/inside.ts', content: 'pwn' }
          }
        })
      ).toBe(false)
    }
  })

  it('distinguishes declared web search from workspace search by stable identity', () => {
    for (const provider of ['grok', 'mistral'] as const) {
      expect(
        structuredProviderNetworkReadRequested(provider, {
          toolName: 'display title',
          toolKind: 'search',
          rawToolCall: {
            kind: 'search',
            rawInput: { tool_name: 'WebSearch', query: 'release gates' }
          }
        })
      ).toBe(true)
      expect(
        structuredProviderNetworkReadRequested(provider, {
          toolName: 'Web Search',
          toolKind: 'search',
          rawToolCall: {
            kind: 'search',
            rawInput: { tool_name: 'Grep', path: 'src', query: 'release gates' }
          }
        })
      ).toBe(false)
    }
  })

  it('denies ambiguous and unknown stable search identities', () => {
    expect(
      structuredProviderNetworkReadRequested('grok', {
        toolName: 'Web Search',
        toolKind: 'search',
        rawToolCall: { kind: 'search', rawInput: { query: 'release gates' } }
      })
    ).toBe(false)
    expect(
      structuredProviderNetworkReadRequested('mistral', {
        toolName: 'display title',
        toolKind: 'search',
        rawToolCall: {
          kind: 'search',
          rawInput: { tool_name: 'FutureSearch', query: 'release gates' }
        }
      })
    ).toBe(false)
  })
})

describe('structuredProviderNetworkAccessAllowed', () => {
  it('treats either run or current global deny as authoritative', () => {
    expect(structuredProviderNetworkAccessAllowed('allow', 'deny')).toBe(false)
    expect(structuredProviderNetworkAccessAllowed('deny', 'allow')).toBe(false)
    expect(structuredProviderNetworkAccessAllowed('allow', 'allow')).toBe(true)
    expect(structuredProviderNetworkAccessAllowed(undefined, undefined)).toBe(true)
  })
})

describe('shouldAdvertiseTaskWraithMcpToGrok', () => {
  it('never advertises outside ACP', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: false,
        approvalMode: 'default',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(false)
  })

  it('auto-advertises write-capable ACP turns', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'default',
        bridgeEnabled: false,
        readOnlyAdvertiseEnabled: false
      })
    ).toBe(true)
  })

  it('requires both read-only gates for plan-mode ACP turns', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: false,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToGrok({
        acpEnabled: true,
        approvalMode: 'plan',
        bridgeEnabled: true,
        readOnlyAdvertiseEnabled: true
      })
    ).toBe(true)
  })
})
