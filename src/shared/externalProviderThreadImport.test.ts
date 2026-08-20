import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND,
  EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND,
  externalProviderThreadImportLabel,
  isExternalProviderThreadImportMessage,
  isExternalProviderThreadImportProvider,
  stripExternalProviderThreadImportContinuity
} from './externalProviderThreadImport'

describe('externalProviderThreadImport', () => {
  it('recognizes only the four bounded source formats', () => {
    for (const provider of ['codex', 'claude', 'cursor', 'antigravity'] as const) {
      expect(isExternalProviderThreadImportProvider(provider)).toBe(true)
      expect(externalProviderThreadImportLabel(provider)).toBeTruthy()
    }
    expect(isExternalProviderThreadImportProvider('gemini')).toBe(false)
  })

  it('recognizes imported transcript rows and their host notice', () => {
    expect(
      isExternalProviderThreadImportMessage({
        metadata: { kind: EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND }
      })
    ).toBe(true)
    expect(
      isExternalProviderThreadImportMessage({
        metadata: { kind: EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND }
      })
    ).toBe(true)
    expect(isExternalProviderThreadImportMessage({ metadata: { kind: 'ordinary' } })).toBe(false)
  })

  it('strips every native-resume carrier while retaining run history', () => {
    const stripped = stripExternalProviderThreadImportContinuity({
      externalProviderThreadImport: { nativeResumeAllowed: false },
      linkedProviderSessionId: 'source-session',
      linkedGeminiSessionId: 'gemini-session',
      taskWraithMcpProfileReceipt: { id: 'receipt' },
      seatGeneration: { id: 'generation' },
      contextCompactionSummary: { text: 'summary' },
      forkContext: { sourceProviderThreadId: 'source-thread' },
      providerMetadata: { kimiAcpNativeSession: true, selectedModelType: 'model-a' },
      runs: [{ runId: 'run-a', providerThreadId: 'thread-a', status: 'completed' }],
      ensemble: {
        participants: [
          {
            id: 'seat-a',
            linkedProviderSessionId: 'seat-session',
            kimiAcpNativeSession: true,
            kimiAcpPostureVersion: 'posture-a',
            taskWraithMcpProfileReceipt: { id: 'seat-receipt' },
            seatGeneration: { id: 'seat-generation' },
            contextCompactionSummary: { text: 'seat-summary' },
            promptShellVersion: 'shell-a',
            promptDynamicStateVersion: 'dynamic-a'
          }
        ]
      }
    })

    expect(stripped).not.toHaveProperty('linkedProviderSessionId')
    expect(stripped).not.toHaveProperty('linkedGeminiSessionId')
    expect(stripped).not.toHaveProperty('taskWraithMcpProfileReceipt')
    expect(stripped).not.toHaveProperty('seatGeneration')
    expect(stripped).not.toHaveProperty('contextCompactionSummary')
    expect(stripped).not.toHaveProperty('forkContext')
    expect(stripped.providerMetadata).toEqual({ selectedModelType: 'model-a' })
    expect(stripped.runs).toEqual([{ runId: 'run-a', status: 'completed' }])
    expect(stripped.ensemble?.participants).toEqual([{ id: 'seat-a' }])
  })
})
