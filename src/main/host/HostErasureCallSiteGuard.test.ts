import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ChatRecord } from '../store/types'
import { ExternalProviderThreadImportService } from '../import/ExternalProviderThreadImport'

/**
 * Recurrence guard for the Host-cutover erasure migration.
 *
 * The same "one caller was never migrated" defect has bitten three times this
 * round: saveChat's 86 callers, then delete/truncate/clear, then the two
 * delegate-wave rollback sites this guard was written for. The rule it pins:
 * production code must never invoke the synchronous AppStore erasure methods
 * directly — they call runLegacyStoreWriteAdmission and throw
 * LegacyStoreWriterGateClosedError once the gate is Host-owned. Route through
 * ChatService (its branch selects legacyStoreWritesOpen() -> sync legacy,
 * else the *ViaHost async variants) or call AppStore.*ViaHost explicitly.
 *
 * The scan covers non-test sources only: test files legitimately exercise the
 * legacy sync path against an open gate. Store internals are the allowlist —
 * store/index.ts defines the methods and its legacy branch calls them.
 */

const SRC_MAIN = join(__dirname, '..')

const ALLOWLIST_PREFIXES = ['src/main/store/'] as const

/**
 * Known-legal branch owners outside the store, pinned explicitly so this list
 * is the audit surface. deleteChatErasureAware (index.ts) IS the sanctioned
 * branch for call sites outside ChatService's scope — it selects
 * legacyStoreWritesOpen() -> sync legacy, else deleteChatViaHost. A match
 * anywhere else fails this guard.
 */
const ALLOWLIST_FUNCTION_OWNERS: ReadonlyArray<{ file: string; functionName: string }> = [
  { file: 'src/main/index.ts', functionName: 'deleteChatErasureAware' }
]

const DIRECT_ERASURE_CALL = /\bAppStore\.(deleteChat|truncateChatHistory|clearChats)\s*\(/g

/**
 * Line span [start, end] of a top-level function body, by brace depth from its
 * declaration line. Sanctioning must not outlive the function's closing brace
 * — an offender placed AFTER the owner function must still trip this guard.
 */
function functionBodySpan(
  lines: string[],
  functionName: string
): { start: number; end: number } | null {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${functionName}\\b`)
  const start = lines.findIndex((line) => declaration.test(line))
  if (start < 0) return null
  let depth = 0
  let opened = false
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '{') {
        depth += 1
        opened = true
      } else if (character === '}') {
        depth -= 1
        if (opened && depth === 0) return { start, end: index }
      }
    }
  }
  return null
}

function* walkSources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const fullPath = join(directory, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      yield* walkSources(fullPath)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      yield fullPath
    }
  }
}

function repoRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\/(src\/main\/.*)$/, '$1')
}

describe('HostErasureCallSiteGuard', () => {
  it('finds no direct synchronous AppStore erasure calls outside the store', () => {
    const offenders: string[] = []
    for (const filePath of walkSources(SRC_MAIN)) {
      const relative = repoRelative(filePath)
      if (ALLOWLIST_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue
      const source = readFileSync(filePath, 'utf8')
      const lines = source.split('\n')
      const ownerSpans = ALLOWLIST_FUNCTION_OWNERS.filter((owner) => owner.file === relative)
        .map((owner) => functionBodySpan(lines, owner.functionName))
        .filter((span): span is { start: number; end: number } => span !== null)
      lines.forEach((line, index) => {
        DIRECT_ERASURE_CALL.lastIndex = 0
        if (DIRECT_ERASURE_CALL.test(line)) {
          const sanctioned = ownerSpans.some((span) => index >= span.start && index <= span.end)
          if (!sanctioned) {
            offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
          }
        }
      })
    }
    expect(
      offenders,
      `Direct synchronous AppStore.deleteChat/truncateChatHistory/clearChats calls ` +
        `throw LegacyStoreWriterGateClosedError once the writer gate is Host-owned. ` +
        `Route these through ChatService (legacyStoreWritesOpen() branch) or ` +
        `AppStore.*ViaHost instead:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})

describe('erasure call-site migration behavior', () => {
  it('does not silently tolerate a refused draft cleanup after a refused-history import', async () => {
    // ExternalProviderThreadImport.ts:597 — the history-disabled path deletes
    // the just-created draft. A genuinely absent draft is a no-op by contract,
    // but a delete that REJECTS must surface loudly (the draft would otherwise
    // leak as an orphan). RED at HEAD: the call was un-awaited behind a sync
    // try/catch, so the rejection never reached the log.
    const raw = [
      JSON.stringify({
        type: 'user',
        sessionId: 'claude-session-cleanup',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' } })
    ].join('\n')
    const refusal = new Error('Host delete refused')
    const rejected = Promise.reject(refusal)
    // Attach a handler so the pre-fix fire-and-forget use does not pollute
    // the run as an unhandled rejection; the assertion is what turns red.
    rejected.catch(() => undefined)
    const deleteChat = vi.fn(() => rejected)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chats: ChatRecord[] = []
      const service = new ExternalProviderThreadImportService({
        readFile: async () => raw,
        stat: async () => ({
          size: Buffer.byteLength(raw),
          mtimeMs: Date.parse('2026-08-01T10:00:00Z'),
          isFile: () => true
        }),
        getChats: () => chats,
        getChat: (chatId) => chats.find((chat) => chat.appChatId === chatId) ?? null,
        createGlobalChat: () => ({
          appChatId: 'chat-cleanup-1',
          scope: 'global',
          chatKind: 'single',
          provider: 'claude',
          title: 'New Chat',
          createdAt: 1,
          updatedAt: 1,
          archived: false,
          messages: [],
          runs: []
        }),
        saveChat: (chat) => chat, // persist: nothing — drives the history-disabled path
        deleteChat
      })
      await expect(
        service.importFile({ provider: 'claude', filePath: '/tmp/session.jsonl' })
      ).rejects.toMatchObject({ code: 'history-disabled' })
      expect(deleteChat).toHaveBeenCalledOnce()
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('draft chat cleanup failed'),
        refusal
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
