import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ChatRecord } from '../store/types'
import { ExternalProviderThreadImportService } from '../import/ExternalProviderThreadImport'

/**
 * Recurrence guard for the Host-cutover writer migration.
 *
 * The same "one caller was never migrated" defect has bitten FIVE times this
 * round: saveChat's 86 callers, then delete/truncate/clear, then the two
 * delegate-wave rollback sites, then the whole workspaces family, then the
 * native folder-picker (WorkspaceService.addWorkspaceFromNativeSelection).
 * Every one was found by a reviewer or by re-reading the spec — never by a
 * test. This guard exists so the sixth instance is found here instead.
 *
 * The rule it pins: production code must never invoke the synchronous AppStore
 * erasure or workspace mutator methods directly — they call
 * runLegacyStoreWriteAdmission and throw LegacyStoreWriterGateClosedError once
 * the gate is Host-owned. Route through the owning service's
 * legacyStoreWritesOpen() branch or the AppStore.*ViaHost variants.
 *
 * Coverage is deliberately two-dimensional: BOTH method families (erasure and
 * workspace mutators) and BOTH receiver shapes (direct `AppStore.` and
 * dependency-injected `deps.appStore.` / `this.deps.appStore.`) — the blind
 * spot on either axis is exactly how the fifth instance slipped through.
 *
 * The scan covers non-test sources only: test files legitimately exercise the
 * legacy sync path against an open gate. Store internals are the allowlist —
 * store/index.ts defines the methods and its legacy branch calls them.
 */

const SRC_MAIN = join(__dirname, '..')

const ALLOWLIST_PREFIXES = ['src/main/store/'] as const

/**
 * Known-legal branch owners outside the store, pinned explicitly so this list
 * is the audit surface. Each entry is a function whose own legacy-branch call
 * is the sanctioned split (legacyStoreWritesOpen() -> sync legacy, else the
 * *ViaHost variant). Sanctioning is resolved by BRACE SPAN, so an offender
 * placed after the owner function still trips this guard, and adding an entry
 * here to silence a genuine offender is visible in review.
 */
const ALLOWLIST_FUNCTION_OWNERS: ReadonlyArray<{ file: string; functionName: string }> = [
  { file: 'src/main/index.ts', functionName: 'deleteChatErasureAware' },
  { file: 'src/main/index.ts', functionName: 'togglePinWorkspaceFn' },
  { file: 'src/main/services/ChatService.ts', functionName: 'deleteChat' },
  { file: 'src/main/services/ChatService.ts', functionName: 'truncateChatHistory' },
  { file: 'src/main/services/ChatService.ts', functionName: 'commitClearChats' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'addOrUpdateWorkspace' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'removeWorkspace' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'clearWorkspaces' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'registerWorkspace' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'reconcileWorkspaceRealPaths' },
  { file: 'src/main/services/WorkspaceService.ts', functionName: 'addWorkspaceFromNativeSelection' }
]

const GUARDED_METHODS = [
  'deleteChat',
  'truncateChatHistory',
  'clearChats',
  'addOrUpdateWorkspace',
  'pinWorkspaceRealPath',
  'removeWorkspace',
  'clearWorkspaces'
] as const

const DIRECT_MUTATION_CALL = new RegExp(
  `\\b(?:AppStore|deps\\.appStore)\\.(?:${GUARDED_METHODS.join('|')})\\s*\\(`,
  'g'
)

/**
 * Line span [start, end] of a named function body, by brace depth from its
 * declaration. Handles top-level functions, class methods (indented, with
 * modifiers and multiline signatures), and arrow-function properties — while
 * deliberately NOT matching interface/type declarations (`name: (args) => T`
 * has no body brace). Sanctioning must not outlive the function's closing
 * brace — an offender placed AFTER the owner function must still trip this
 * guard.
 */
function functionBodySpan(
  lines: string[],
  functionName: string
): { start: number; end: number } | null {
  const declaration = new RegExp(
    `^\\s*(?:(?:async|static|public|private|protected)\\s+)*` +
      `(?:(?:function\\s+)?${functionName}\\s*(?:<[^>]*>)?\\s*\\(|${functionName}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{)`
  )
  const start = lines.findIndex((line) => declaration.test(line))
  if (start < 0) return null
  let depth = 0
  let bodyOpened = false
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '{') {
        depth += 1
      } else if (character === '}') {
        depth -= 1
      }
    }
    // Evaluate depth only at line end: a balanced inline `{}` (a default
    // parameter like `= {}`) must not read as the function's closing brace.
    if (depth > 0) bodyOpened = true
    else if (bodyOpened && depth === 0) return { start, end: index }
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
  it('finds no direct synchronous AppStore erasure/workspace-mutator calls outside the store', () => {
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
        DIRECT_MUTATION_CALL.lastIndex = 0
        if (DIRECT_MUTATION_CALL.test(line)) {
          const sanctioned = ownerSpans.some((span) => index >= span.start && index <= span.end)
          if (!sanctioned) {
            offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
          }
        }
      })
    }
    expect(
      offenders,
      `Direct synchronous AppStore.deleteChat/truncateChatHistory/clearChats/` +
        `addOrUpdateWorkspace/pinWorkspaceRealPath/removeWorkspace/clearWorkspaces calls ` +
        `throw LegacyStoreWriterGateClosedError once the writer gate is Host-owned. ` +
        `Route these through the owning service's legacyStoreWritesOpen() branch or ` +
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
