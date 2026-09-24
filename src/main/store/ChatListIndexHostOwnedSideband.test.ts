/**
 * Chat-list index persistence under Host ownership of legacy writes.
 *
 * The chat-list index is a DERIVED, self-invalidating sideband cache — every
 * entry vouches for the chat file it was built from via mtime+size, so a stale
 * entry is ignored, never trusted. That makes it safe to refresh even while the
 * external Host owns the authoritative legacy bytes: the Host never maintains
 * the index, so gating its refresh on `legacyStoreCanWrite()` alone (which is
 * false under Host ownership) let it rot corpus-wide. A rotted index cannot
 * vouch, so every boot corpus scan and first-paint getChatList degraded from a
 * stat-only shortcut into a full-record read+replay — the enabler of the
 * 30-60min cold-boot window stall on large profiles.
 *
 * These tests pin the sideband contract on the real AppStore:
 *   - gate OPEN (in-process owns writes): getChatList persists index entries
 *     (harness sanity — the restamp door actually fires);
 *   - gate HOST-OWNED: getChatList STILL persists them (the fix — the whole
 *     point) even though the legacy write admission is closed;
 *   - gate DRAINING: getChatList persists NOTHING (the predicate stays narrow —
 *     an index refresh must never publish mid-drain, the invariant the shared
 *     write gate protects).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

type GateMode = 'open' | 'host-owned' | 'draining'

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
}

async function importStore(mode: GateMode): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-index-sideband-'))
  profiles.push(profilePath)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('./index')
  if (mode !== 'open') {
    const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
    if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
    if (mode === 'host-owned') {
      const owned = legacyStoreWriterGate.markHostOwned({
        hostId: 'test-host',
        generation: 1,
        cutoverId: 'test-cutover'
      })
      if (!owned) throw new Error('test gate did not become host-owned')
    }
  }
  return { AppStore, profilePath }
}

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-01T00:00:00.000Z' }
}

function durableChat(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: `Durable ${chatId}`,
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 3,
    archived: false,
    messages: [
      message('m1', 'user', 'First message'),
      message('m2', 'assistant', 'Second message')
    ],
    runs: []
  }
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(chatsDir, `${chat.appChatId}.json`), JSON.stringify(chat))
}

/** Chat ids that own an entry line in the persisted chat-list index. */
function indexedChatIds(profilePath: string): string[] {
  const indexPath = join(profilePath, 'chat-list-index.jsonl')
  if (!existsSync(indexPath)) return []
  const seen = new Set<string>()
  for (const line of readFileSync(indexPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec && typeof rec.chatId === 'string' && rec.entry) seen.add(rec.chatId)
    } catch {
      /* skip corrupt */
    }
  }
  return [...seen].sort()
}

describe('chat-list index — Host-ownership sideband persistence', () => {
  it('gate OPEN: getChatList persists a fresh index entry (harness sanity)', async () => {
    const { AppStore, profilePath } = await importStore('open')
    seedDurableChat(profilePath, durableChat('chat-open'))

    AppStore.getChatList()

    expect(indexedChatIds(profilePath)).toEqual(['chat-open'])
  })

  it('gate HOST-OWNED: getChatList STILL persists the index entry (the fix)', async () => {
    const { AppStore, profilePath } = await importStore('host-owned')
    seedDurableChat(profilePath, durableChat('chat-a'))
    seedDurableChat(profilePath, durableChat('chat-b'))

    // Under Host ownership the legacy write admission is closed; a naive gate
    // (legacyStoreCanWrite only) skips the restamp and the index never persists,
    // which is exactly the corpus-wide rot that made boot scans full reads.
    AppStore.getChatList()

    expect(indexedChatIds(profilePath)).toEqual(['chat-a', 'chat-b'])
  })

  it('gate DRAINING: getChatList persists nothing (predicate stays narrow)', async () => {
    const { AppStore, profilePath } = await importStore('draining')
    seedDurableChat(profilePath, durableChat('chat-draining'))

    // Draining is neither in-process-writable nor Host-owned: an index refresh
    // must not publish mid-drain. The sideband predicate is deliberately narrow.
    AppStore.getChatList()

    expect(indexedChatIds(profilePath)).toEqual([])
  })
})
