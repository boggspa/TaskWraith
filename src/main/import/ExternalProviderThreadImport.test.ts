import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import {
  EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_FILE_BYTES,
  EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS,
  ExternalProviderThreadImportService,
  parseExternalProviderThread
} from './ExternalProviderThreadImport'

describe('parseExternalProviderThread', () => {
  it('parses Codex event and response rows without importing tool calls', () => {
    const parsed = parseExternalProviderThread(
      'codex',
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-a' } }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:00Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Inspect this.' }
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:01Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }]
          }
        }),
        JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } })
      ].join('\n')
    )
    expect(parsed).toMatchObject({
      sourceConversationId: 'codex-session-a',
      messages: [
        { role: 'user', content: 'Inspect this.' },
        { role: 'assistant', content: 'Done.' }
      ]
    })
  })

  it('parses Claude, Cursor, and AntiGravity message shapes', () => {
    const claude = parseExternalProviderThread(
      'claude',
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-session-a',
          uuid: 'u1',
          timestamp: '2026-08-01T10:00:00Z',
          message: { role: 'user', content: 'Question' }
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-01T10:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] }
        }),
        JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'skip' } })
      ].join('\n')
    )
    expect(claude.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' }
    ])

    const cursor = parseExternalProviderThread(
      'cursor',
      [
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Build' }] } }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Built' }] }
        })
      ].join('\n')
    )
    expect(cursor.messages.map((message) => message.content)).toEqual(['Build', 'Built'])

    const antigravity = parseExternalProviderThread(
      'antigravity',
      [
        JSON.stringify({
          step_index: 1,
          source: 'USER',
          type: 'USER_INPUT',
          created_at: '2026-08-01T10:00:00Z',
          content: 'Review'
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-08-01T10:00:01Z',
          content: 'Reviewed',
          thinking: 'must never import',
          tool_calls: null
        }),
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'VIEW_FILE',
          content: 'secret tool output'
        })
      ].join('\n')
    )
    expect(antigravity.messages.map((message) => message.content)).toEqual(['Review', 'Reviewed'])
    expect(JSON.stringify(antigravity)).not.toContain('must never import')
    expect(JSON.stringify(antigravity)).not.toContain('secret tool output')
  })

  it('truncates oversized message text deterministically', () => {
    const parsed = parseExternalProviderThread(
      'claude',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'x'.repeat(EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS + 10)
        }
      })
    )
    expect(parsed.truncated).toBe(true)
    expect(parsed.messages[0].content).toHaveLength(
      EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS
    )
    expect(parsed.messages[0].content.endsWith('…')).toBe(true)
  })
})

function serviceHarness(raw: string, size = Buffer.byteLength(raw), persist = true) {
  const chats: ChatRecord[] = []
  let id = 0
  const service = new ExternalProviderThreadImportService({
    readFile: async () => raw,
    stat: async () => ({ size, mtimeMs: Date.parse('2026-08-01T10:00:00Z'), isFile: () => true }),
    getChats: () => chats,
    getChat: (chatId) => chats.find((chat) => chat.appChatId === chatId) ?? null,
    createGlobalChat: () => ({
      appChatId: `chat-${chats.length + 1}`,
      scope: 'global',
      chatKind: 'single',
      provider: 'codex',
      title: 'New Chat',
      createdAt: Date.parse('2026-08-20T09:00:00Z'),
      updatedAt: Date.parse('2026-08-20T09:00:00Z'),
      archived: false,
      messages: [],
      runs: []
    }),
    saveChat: (chat) => {
      if (persist) chats.push(chat)
      return chat
    },
    deleteChat: (chatId) => {
      const index = chats.findIndex((chat) => chat.appChatId === chatId)
      if (index >= 0) chats.splice(index, 1)
    },
    now: () => Date.parse('2026-08-20T09:00:00Z'),
    createId: () => `import-id-${++id}`
  })
  return { chats, service }
}

describe('ExternalProviderThreadImportService', () => {
  it('creates an archived, untrusted, non-resumable snapshot and deduplicates it', async () => {
    const raw = [
      JSON.stringify({
        type: 'user',
        sessionId: 'native-session-must-not-resume',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' } })
    ].join('\n')
    const { chats, service } = serviceHarness(raw)
    const first = await service.importFile({
      provider: 'claude',
      filePath: '/Users/private/.claude/projects/repo/session.jsonl'
    })
    expect(first).toMatchObject({ duplicate: false, importedMessageCount: 2 })
    expect(first.chat).toMatchObject({
      scope: 'global',
      provider: 'codex',
      archived: true,
      runs: [],
      externalProviderThreadImport: {
        provider: 'claude',
        trust: 'external_untrusted',
        sourceFileName: 'session.jsonl',
        sourceConversationId: 'native-session-must-not-resume',
        promptBridgeEnabled: false,
        nativeResumeAllowed: false
      }
    })
    expect(
      first.chat.messages
        .slice(1)
        .every((message) => message.metadata?.sourceTrust === 'external_untrusted')
    ).toBe(true)
    expect(first.chat.messages[0].content).toContain('Add to prompt')
    expect(first.chat).not.toHaveProperty('linkedProviderSessionId')
    expect(first.chat).not.toHaveProperty('linkedGeminiSessionId')
    expect(JSON.stringify(first.chat)).not.toContain('/Users/private')

    const second = await service.importFile({
      provider: 'claude',
      filePath: '/elsewhere/copy.jsonl'
    })
    expect(second.duplicate).toBe(true)
    expect(second.chat.appChatId).toBe(first.chat.appChatId)
    expect(chats).toHaveLength(1)
  })

  it('deduplicates concurrent imports atomically inside main', async () => {
    const raw = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'same bytes' }
    })
    const { chats, service } = serviceHarness(raw)
    const results = await Promise.all([
      service.importFile({ provider: 'claude', filePath: '/tmp/a.jsonl' }),
      service.importFile({ provider: 'claude', filePath: '/tmp/b.jsonl' })
    ])

    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
    expect(new Set(results.map((result) => result.chat.appChatId)).size).toBe(1)
    expect(chats).toHaveLength(1)
  })

  it('rejects oversized and message-free files without persisting a chat', async () => {
    const oversized = serviceHarness('{}', EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_FILE_BYTES + 1)
    await expect(
      oversized.service.importFile({ provider: 'codex', filePath: '/tmp/large.jsonl' })
    ).rejects.toMatchObject({ code: 'file-too-large' })
    expect(oversized.chats).toEqual([])

    const empty = serviceHarness(JSON.stringify({ type: 'summary', content: 'not a turn' }))
    await expect(
      empty.service.importFile({ provider: 'claude', filePath: '/tmp/empty.jsonl' })
    ).rejects.toMatchObject({ code: 'no-messages' })
    expect(empty.chats).toEqual([])
  })

  it('rejects TaskWraith-owned Codex and Cursor sandbox/subagent transcripts', async () => {
    const ownedCodex = serviceHarness(
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'owned', originator: 'taskwraith' }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'already managed' }
        })
      ].join('\n')
    )
    await expect(
      ownedCodex.service.importFile({ provider: 'codex', filePath: '/tmp/owned.jsonl' })
    ).rejects.toThrow(/already managed/i)
    expect(ownedCodex.chats).toEqual([])

    const cursor = serviceHarness(
      JSON.stringify({ role: 'user', message: { content: 'sandbox row' } })
    )
    await expect(
      cursor.service.importFile({
        provider: 'cursor',
        filePath: '/Users/test/.cursor/projects/tmp-taskwraith/agent-transcripts/subagents/a.jsonl'
      })
    ).rejects.toThrow(/not importable/i)
    expect(cursor.chats).toEqual([])
  })

  it('refuses to report success when local chat history is disabled', async () => {
    const disabled = serviceHarness(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      undefined,
      false
    )
    await expect(
      disabled.service.importFile({ provider: 'claude', filePath: '/tmp/thread.jsonl' })
    ).rejects.toMatchObject({ code: 'history-disabled' })
    expect(disabled.chats).toEqual([])
  })
})
