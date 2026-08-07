import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-history-deletion-run-event-scan-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatsDir = join(userDataPath, 'chats')
const runEventsDir = join(userDataPath, 'run-events')

/** Mirrors the probe's read size in store/index.ts. */
const PROBE_CHUNK_BYTES = 1 << 20

const TARGET_CHAT = '11111111-1111-4111-8111-111111111111'
const OTHER_CHAT = '22222222-2222-4222-8222-222222222222'
const CHAT_CREATED_AT = Date.parse('2026-08-01T00:00:00.000Z')

function saveChat(chatId: string, createdAt = CHAT_CREATED_AT): void {
  const chat = {
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: chatId,
    workspaceId: 'ws-1',
    workspacePath: '/repo/ws-1',
    createdAt,
    updatedAt: createdAt,
    archived: false,
    messages: [],
    runs: []
  } as unknown as ChatRecord
  AppStore.saveChat(chat)
}

function writeLedger(runId: string, lines: string[], mtimeMs = CHAT_CREATED_AT + 60_000): void {
  const filePath = join(runEventsDir, `${runId}.jsonl`)
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
  const seconds = mtimeMs / 1000
  fs.utimesSync(filePath, seconds, seconds)
}

function eventLine(chatId: string, runId: string): string {
  return JSON.stringify({ kind: 'run/started', chatId, runId, at: CHAT_CREATED_AT })
}

function previewRunIds(): string[] {
  return AppStore.previewHistoryDeletionScope({ kind: 'chat', rootChatId: TARGET_CHAT }).runIds
}

describe('scoped history deletion — run-events reconciliation scan', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
    fs.mkdirSync(runEventsDir, { recursive: true })
    saveChat(TARGET_CHAT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(userDataPath, { recursive: true, force: true })
  })

  it('still claims a run that reached the ledger before it was attached to the chat', () => {
    // The whole reason this sweep exists: the chat record lists no runs, so the
    // ledger is the only place this run's ownership is recorded.
    writeLedger('orphan-run', [eventLine(TARGET_CHAT, 'orphan-run')])

    expect(previewRunIds()).toContain('orphan-run')
  })

  it('claims a run whose chat id straddles the probe read boundary', () => {
    // A needle split across two reads is invisible to a probe that forgets to
    // carry an overlap, and the run would then survive the erasure silently.
    const prefix = '{"chatId":"'
    const padLine = '{"pad":"'
    // Land the id 10 bytes before the boundary so it spans two chunks.
    const padBytes = PROBE_CHUNK_BYTES - 10 - prefix.length - (padLine.length + 2 + 1)
    writeLedger('straddle-run', [
      `${padLine}${'x'.repeat(padBytes)}"}`,
      `${prefix}${TARGET_CHAT}","runId":"straddle-run"}`
    ])

    const runIds = previewRunIds()
    expect(runIds).toContain('straddle-run')
  })

  it('leaves another chat’s runs alone', () => {
    writeLedger('orphan-run', [eventLine(TARGET_CHAT, 'orphan-run')])
    writeLedger('other-chat-run', [eventLine(OTHER_CHAT, 'other-chat-run')])

    const runIds = previewRunIds()
    expect(runIds).toContain('orphan-run')
    expect(runIds).not.toContain('other-chat-run')
  })

  it('claims a run only on an identity field, not a passing mention of the chat id', () => {
    // The byte probe deliberately admits this file; correctness still comes
    // from the parse, so a chat id quoted in an unrelated field must not claim
    // the run.
    writeLedger('mention-run', [
      JSON.stringify({ kind: 'tool/progress', note: TARGET_CHAT, runId: 'mention-run' })
    ])

    expect(previewRunIds()).not.toContain('mention-run')
  })

  it('bounds the sweep to ledgers written after the chat existed', () => {
    // Deliberate, and the one place this sweep trades completeness for cost: a
    // ledger last written long before the chat was created cannot name it, so
    // it is skipped without being read. The margin absorbs clock skew.
    writeLedger(
      'ancient-run',
      [eventLine(TARGET_CHAT, 'ancient-run')],
      CHAT_CREATED_AT - 400 * 86_400_000
    )

    expect(previewRunIds()).not.toContain('ancient-run')
  })
})
