import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from './types'
import { AppStore } from '../store'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-external-provider-import-test',
    getVersion: () => 'test'
  }
}))

describe('AppStore external provider import continuity fence', () => {
  it('normalizes imported records without provider-native resume identity', () => {
    const chat: ChatRecord = {
      appChatId: 'imported-chat',
      scope: 'global',
      chatKind: 'single',
      provider: 'codex',
      title: 'Imported Claude',
      createdAt: 1,
      updatedAt: 2,
      archived: true,
      messages: [],
      runs: [
        {
          runId: 'run-a',
          providerThreadId: 'native-thread-a',
          startedAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      linkedProviderSessionId: 'native-session-a',
      linkedGeminiSessionId: 'gemini-session-a',
      forkContext: {
        kind: 'native',
        createdAt: 1,
        sourceProviderThreadId: 'source-thread-a'
      },
      externalProviderThreadImport: {
        schemaVersion: 1,
        provider: 'claude',
        trust: 'external_untrusted',
        sourceFileName: 'thread.jsonl',
        sourceFingerprintSha256: 'a'.repeat(64),
        sourceMessageCount: 1,
        importedMessageCount: 1,
        omittedRecordCount: 0,
        invalidRecordCount: 0,
        importedAt: '2026-08-20T00:00:00.000Z',
        truncated: false,
        promptBridgeEnabled: false,
        nativeResumeAllowed: false
      }
    }

    const normalized = AppStore.normalizeChatRecord(chat)
    expect(normalized.linkedProviderSessionId).toBeUndefined()
    expect(normalized.linkedGeminiSessionId).toBeUndefined()
    expect(normalized.forkContext).toBeUndefined()
    expect(normalized.runs[0].providerThreadId).toBeUndefined()
  })
})
