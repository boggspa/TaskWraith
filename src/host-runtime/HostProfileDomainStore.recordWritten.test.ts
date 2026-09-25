/**
 * Independent Threads M4 slice 13c1 (design §23.6, test 1): the store's
 * `onThreadRecordWritten` hook. Every chat-file writer fires it after the
 * file is replaced or removed, with the kind the feeder keys on: `record`
 * for setup, the seat toggle, archive and the legacy persist (both the
 * normal write and the adopt-by-rename path); `run` for the three run-port
 * writes; `deleted` for the unlink. A failed write fires nothing, a throwing
 * hook never fails the write, and the transaction's own commit path (the
 * commit port over the store) fires nothing: it feeds the index itself.
 * Since slice 13c2 (§23.8) every write passes the canonical thread it
 * published, which decodes equal to the file; the delete passes none.
 *
 * The behavioural half runs the real store in a temp profile. The closure
 * half is an AST probe over the store's source: every chat-path
 * `atomicJson`, the adopt rename and the unlink sit in code paths that call
 * the hook, and the set of methods reaching `writeThread` is pinned, so a
 * new writer must be added here (with its behavioural case) or the closure
 * reds.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

import { afterEach, describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../main/mainSourceProbe.testutil'
import {
  decodeHostProfileThread,
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore,
  type HostProfileDomainStoreOptions,
  type HostProfileThread,
  type HostThreadRecordWrittenKind
} from './HostProfileDomainStore'
import { createHostThreadRecordCommitPort } from './HostThreadRecordTransaction'
import {
  decodeHostThreadRecordTransferBody,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  verifyHostThreadRecordTransfer
} from './HostThreadRecordTransfer'

const NOW = 1_760_000_000_000
const STARTED_AT = new Date(NOW).toISOString()

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Fired = { threadId: string; kind: HostThreadRecordWrittenKind }

interface Harness {
  profilePath: string
  store: HostProfileDomainStore
  fired: Fired[]
  /** What the hook saw on disk for its thread at the moment it fired. */
  seen: Array<{ exists: boolean; title: string | null }>
  /** The thread each call passed (13c2), or undefined. */
  passed: Array<HostProfileThread | undefined>
  chatPath(threadId: string): string
  /** The file's record as the store's decoder reads it. */
  decoded(threadId: string): HostProfileThread
}

function harness(
  overrides: Partial<HostProfileDomainStoreOptions> = {},
  hook?: (threadId: string, kind: HostThreadRecordWrittenKind) => void
): Harness {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-store-record-written-'))
  roots.push(profilePath)
  const fired: Fired[] = []
  const seen: Harness['seen'] = []
  const passed: Harness['passed'] = []
  const chatPath = (threadId: string): string =>
    join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW,
    idFactory: () => `thread-${++sequence}`,
    onThreadRecordWritten: (threadId, kind, thread) => {
      fired.push({ threadId, kind })
      passed.push(thread)
      const path = chatPath(threadId)
      const exists = existsSync(path)
      seen.push({
        exists,
        title: exists
          ? ((JSON.parse(readFileSync(path, 'utf8')) as { title?: string }).title ?? null)
          : null
      })
      hook?.(threadId, kind)
    },
    ...overrides
  })
  return {
    profilePath,
    store,
    fired,
    seen,
    passed,
    chatPath,
    decoded: (threadId) =>
      decodeHostProfileThread(JSON.parse(readFileSync(chatPath(threadId), 'utf8')) as unknown)
  }
}

function publishTransfer(profilePath: string, transferId: string, record: unknown) {
  const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId, record })
  const verified = verifyHostThreadRecordTransfer({ profilePath, descriptor })
  return { descriptor, verified, record: decodeHostThreadRecordTransferBody(verified.body) }
}

describe('HostProfileDomainStore.onThreadRecordWritten (M4 slice 13c1)', () => {
  describe('every writer fires the hook with its kind, after the file changed', () => {
    it('createThread fires record once the new file is on disk', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Created' })
      expect(h.fired).toEqual([{ threadId: created.appChatId, kind: 'record' }])
      expect(h.seen).toEqual([{ exists: true, title: 'Created' }])
    })

    it('configureThread fires record with the configured file already published', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Before' })
      h.fired.length = 0
      h.seen.length = 0
      h.store.configureThread({ threadId: created.appChatId, title: 'Configured' })
      expect(h.fired).toEqual([{ threadId: created.appChatId, kind: 'record' }])
      expect(h.seen).toEqual([{ exists: true, title: 'Configured' }])
    })

    it('setThreadKind fires record for the toggle to ensemble and back to single', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Seat' })
      h.store.configureThread({ threadId: created.appChatId, providerId: 'codex' })
      h.fired.length = 0
      h.store.setThreadKind({ threadId: created.appChatId, targetKind: 'ensemble' })
      h.store.setThreadKind({
        threadId: created.appChatId,
        targetKind: 'single',
        canonicalProviderId: 'codex'
      })
      expect(h.fired).toEqual([
        { threadId: created.appChatId, kind: 'record' },
        { threadId: created.appChatId, kind: 'record' }
      ])
    })

    it('a setThreadKind to the kind the thread already has writes nothing and fires nothing', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Seat' })
      h.fired.length = 0
      h.store.setThreadKind({ threadId: created.appChatId, targetKind: 'single' })
      expect(h.fired).toEqual([])
    })

    it('archiveThread fires record for a change and nothing for a no-op', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Archive' })
      h.fired.length = 0
      h.store.archiveThread(created.appChatId, true)
      expect(h.fired).toEqual([{ threadId: created.appChatId, kind: 'record' }])
      h.store.archiveThread(created.appChatId, true)
      expect(h.fired).toHaveLength(1)
    })

    it('persistThreadRecord fires record on the normal write, for a new and an existing thread', () => {
      const h = harness()
      const record = {
        appChatId: 'persisted-1',
        scope: 'global',
        title: 'Persisted',
        archived: false,
        createdAt: 10,
        messages: [],
        runs: [],
        updatedAt: 20
      }
      h.store.persistThreadRecord({ threadId: 'persisted-1', record, expectedRevision: 0 })
      expect(h.fired).toEqual([{ threadId: 'persisted-1', kind: 'record' }])
      expect(h.seen).toEqual([{ exists: true, title: 'Persisted' }])
      h.store.persistThreadRecord({
        threadId: 'persisted-1',
        record: { ...record, title: 'Persisted again' },
        expectedRevision: 0
      })
      expect(h.fired).toHaveLength(2)
      expect(h.fired[1]).toEqual({ threadId: 'persisted-1', kind: 'record' })
      expect(h.seen[1]).toEqual({ exists: true, title: 'Persisted again' })
    })

    it('persistThreadRecord fires record on the adopt-by-rename path, after the rename', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Adopt base' })
      h.fired.length = 0
      h.seen.length = 0
      // Stamped ahead of its CAS base with every adoption field intact: the
      // artifact bytes become the chat file by rename.
      const transfer = publishTransfer(h.profilePath, 'adopt-1', {
        ...created,
        persistenceRevision: 1,
        title: 'Adopted'
      })
      const artifactBytes = readFileSync(transfer.verified.path)
      h.store.persistThreadRecord({
        threadId: created.appChatId,
        record: transfer.record,
        expectedRevision: 0,
        verifiedTransfer: {
          path: transfer.verified.path,
          identity: transfer.verified.identity,
          byteLength: transfer.descriptor.byteLength
        }
      })
      // The adopt path, not the normal write: the chat file IS the artifact.
      expect(readFileSync(h.chatPath(created.appChatId)).equals(artifactBytes)).toBe(true)
      expect(existsSync(hostThreadRecordTransferPath(h.profilePath, 'adopt-1'))).toBe(false)
      expect(h.fired).toEqual([{ threadId: created.appChatId, kind: 'record' }])
      expect(h.seen).toEqual([{ exists: true, title: 'Adopted' }])
    })

    it('appendTranscript, updateRun and recordRunTool fire run', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Runs' })
      h.fired.length = 0
      h.seen.length = 0
      h.store.appendTranscript({ threadId: created.appChatId, role: 'user', content: 'hello' })
      h.store.updateRun({
        threadId: created.appChatId,
        runId: 'run-1',
        status: 'running',
        provider: 'codex',
        phase: 'starting',
        startedAt: STARTED_AT
      })
      h.store.recordRunTool({
        threadId: created.appChatId,
        runId: 'run-1',
        toolId: 'tool-1',
        toolName: 'Edit',
        phase: 'started'
      })
      expect(h.fired).toEqual([
        { threadId: created.appChatId, kind: 'run' },
        { threadId: created.appChatId, kind: 'run' },
        { threadId: created.appChatId, kind: 'run' }
      ])
      expect(h.seen).toHaveLength(3)
      for (const view of h.seen) expect(view.exists).toBe(true)
    })

    it('deleteThreadRecord fires deleted after the unlink', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Doomed' })
      h.fired.length = 0
      h.seen.length = 0
      expect(h.store.deleteThreadRecord({ threadId: created.appChatId, expectedRevision: 0 })).toBe(
        true
      )
      expect(h.fired).toEqual([{ threadId: created.appChatId, kind: 'deleted' }])
      expect(h.seen).toEqual([{ exists: false, title: null }])
    })
  })

  describe('the hook receives the written thread (13c2), and none for the delete', () => {
    it('writeThread passes the record it returned, which decodes equal to the file, for every writer', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Passed' })
      const threadId = created.appChatId
      const returned: HostProfileThread[] = [created]
      returned.push(h.store.configureThread({ threadId, providerId: 'codex', title: 'Configured' }))
      returned.push(h.store.setThreadKind({ threadId, targetKind: 'ensemble' }))
      returned.push(
        h.store.setThreadKind({ threadId, targetKind: 'single', canonicalProviderId: 'codex' })
      )
      returned.push(h.store.archiveThread(threadId, true))
      returned.push(h.store.archiveThread(threadId, false))
      returned.push(h.store.appendTranscript({ threadId, role: 'user', content: 'hello' }))
      returned.push(
        h.store.updateRun({
          threadId,
          runId: 'run-1',
          status: 'running',
          provider: 'codex',
          phase: 'starting',
          startedAt: STARTED_AT
        })
      )
      returned.push(
        h.store.recordRunTool({
          threadId,
          runId: 'run-1',
          toolId: 'tool-1',
          toolName: 'Edit',
          phase: 'started'
        })
      )
      returned.push(
        h.store.updateRun({ threadId, runId: 'run-1', status: 'completed', endedAt: STARTED_AT })
      )
      const current = h.store.getThread(threadId)!
      returned.push(
        h.store.persistThreadRecord({
          threadId,
          record: { ...current, title: 'Persisted' },
          expectedRevision: current.persistenceRevision ?? 0
        })
      )
      expect(returned).toHaveLength(11)
      expect(h.fired.map((entry) => entry.kind)).toEqual([
        'record',
        'record',
        'record',
        'record',
        'record',
        'record',
        'run',
        'run',
        'run',
        'run',
        'record'
      ])
      expect(h.passed).toHaveLength(returned.length)
      for (const [index, thread] of returned.entries()) {
        // The very object the writer published and returned, by identity.
        expect(h.passed[index]).toBe(thread)
        expect(thread.persistenceRevision).toBe(index)
      }
      // The last one is the file: the decoder reads back what was passed.
      expect(h.passed.at(-1)).toEqual(h.decoded(threadId))
      expect(h.decoded(threadId).title).toBe('Persisted')
    })

    it('the adopt-by-rename path passes the published record, which decodes equal to the adopted file', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Adopt base' })
      h.passed.length = 0
      const transfer = publishTransfer(h.profilePath, 'adopt-2', {
        ...created,
        persistenceRevision: 1,
        title: 'Adopted with record'
      })
      const adopted = h.store.persistThreadRecord({
        threadId: created.appChatId,
        record: transfer.record,
        expectedRevision: 0,
        verifiedTransfer: {
          path: transfer.verified.path,
          identity: transfer.verified.identity,
          byteLength: transfer.descriptor.byteLength
        }
      })
      expect(existsSync(hostThreadRecordTransferPath(h.profilePath, 'adopt-2'))).toBe(false)
      expect(h.passed).toHaveLength(1)
      expect(h.passed[0]).toBe(adopted)
      expect(h.passed[0]).toEqual(h.decoded(created.appChatId))
      expect(h.passed[0]!.title).toBe('Adopted with record')
      expect(h.passed[0]!.persistenceRevision).toBe(1)
    })

    it('the delete passes no thread', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Doomed' })
      expect(h.passed).toHaveLength(1)
      expect(h.passed[0]).toBeDefined()
      h.passed.length = 0
      expect(h.store.deleteThreadRecord({ threadId: created.appChatId, expectedRevision: 0 })).toBe(
        true
      )
      expect(h.fired.at(-1)).toEqual({ threadId: created.appChatId, kind: 'deleted' })
      expect(h.passed).toEqual([undefined])
    })
  })

  describe('a failed write fires nothing', () => {
    it('a write that fails before its rename', () => {
      let failing = false
      const h = harness({
        beforeAtomicPublish: () => {
          if (failing) throw new Error('injected publish failure')
        }
      })
      const created = h.store.createThread({ scope: 'global', title: 'Stable' })
      h.fired.length = 0
      failing = true
      expect(() =>
        h.store.configureThread({ threadId: created.appChatId, title: 'Never lands' })
      ).toThrow('injected publish failure')
      expect(() => h.store.createThread({ scope: 'global', title: 'Never born' })).toThrow(
        'injected publish failure'
      )
      expect(() =>
        h.store.appendTranscript({ threadId: created.appChatId, role: 'user', content: 'x' })
      ).toThrow('injected publish failure')
      expect(h.fired).toEqual([])
      expect(
        (JSON.parse(readFileSync(h.chatPath(created.appChatId), 'utf8')) as { title: string }).title
      ).toBe('Stable')
    })

    it('a refused persist and a refused delete', () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Guarded' })
      h.fired.length = 0
      expect(() =>
        h.store.persistThreadRecord({
          threadId: created.appChatId,
          record: { ...created, title: 'Conflict' },
          expectedRevision: 7
        })
      ).toThrow('Thread persistence revision mismatch')
      expect(() =>
        h.store.deleteThreadRecord({ threadId: created.appChatId, expectedRevision: 7 })
      ).toThrow('Thread persistence revision mismatch')
      expect(h.store.deleteThreadRecord({ threadId: 'never-existed', expectedRevision: 0 })).toBe(
        false
      )
      expect(h.fired).toEqual([])
      expect(existsSync(h.chatPath(created.appChatId))).toBe(true)
    })
  })

  describe('a throwing hook never breaks the write', () => {
    it('every kind: the write stands and the store keeps working', () => {
      const h = harness({}, () => {
        throw new Error('hook exploded')
      })
      const created = h.store.createThread({ scope: 'global', title: 'Sturdy' })
      expect(existsSync(h.chatPath(created.appChatId))).toBe(true)
      const configured = h.store.configureThread({
        threadId: created.appChatId,
        title: 'Still sturdy'
      })
      expect(configured.title).toBe('Still sturdy')
      const appended = h.store.appendTranscript({
        threadId: created.appChatId,
        role: 'user',
        content: 'hello'
      })
      expect(appended.messages).toHaveLength(1)
      expect(h.store.getThread(created.appChatId)?.messages).toHaveLength(1)
      expect(
        h.store.deleteThreadRecord({
          threadId: created.appChatId,
          expectedRevision: appended.persistenceRevision ?? 0
        })
      ).toBe(true)
      expect(existsSync(h.chatPath(created.appChatId))).toBe(false)
      expect(h.fired.map((entry) => entry.kind)).toEqual(['record', 'record', 'run', 'deleted'])
    })

    it('a store without the option writes as before', () => {
      const profilePath = mkdtempSync(join(tmpdir(), 'host-store-no-hook-'))
      roots.push(profilePath)
      const store = new HostProfileDomainStore({
        profilePath,
        authority: { assertProfileAuthority: () => undefined },
        now: () => NOW
      })
      const created = store.createThread({ scope: 'global', title: 'Unhooked' })
      expect(
        existsSync(join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${created.appChatId}.json`))
      ).toBe(true)
      expect(store.deleteThreadRecord({ threadId: created.appChatId, expectedRevision: 0 })).toBe(
        true
      )
    })
  })

  describe("the transaction's commit does not fire it", () => {
    it('the commit port renames an artifact into place and admits the record without the hook', async () => {
      const h = harness()
      const created = h.store.createThread({ scope: 'global', title: 'Transactional' })
      h.fired.length = 0
      const records = createHostThreadRecordCommitPort({
        store: h.store,
        profilePath: h.profilePath,
        beginTicket: async () => ({ finish: () => undefined, fail: () => undefined })
      })
      const state = h.store.threadRecordState(created.appChatId)
      expect(state).not.toBeNull()
      const transfer = publishTransfer(h.profilePath, 'txn-1', {
        ...created,
        persistenceRevision: 1,
        title: 'Committed by the transaction'
      })
      const renamed = records.commitRename(transfer.verified.path, created.appChatId, state!.key)
      expect(renamed).toBe('renamed')
      records.committed(created.appChatId, 1, null)
      await records.syncChatsDirectory(created.appChatId)
      expect(
        (JSON.parse(readFileSync(h.chatPath(created.appChatId), 'utf8')) as { title: string }).title
      ).toBe('Committed by the transaction')
      expect(h.store.threadRecordState(created.appChatId)?.revision).toBe(1)
      expect(h.fired).toEqual([])
    })
  })

  describe('source closure over HostProfileDomainStore', () => {
    const probe = new MainSourceProbe(
      'HostProfileDomainStore.ts',
      new URL('./HostProfileDomainStore.ts', import.meta.url)
    )
    const transactionProbe = new MainSourceProbe(
      'HostThreadRecordTransaction.ts',
      new URL('./HostThreadRecordTransaction.ts', import.meta.url)
    )

    /** The class body, or a throw: a renamed class must not pass vacuously. */
    function storeClass(): ts.ClassDeclaration {
      let found: ts.ClassDeclaration | undefined
      ts.forEachChild(probe.source, (node) => {
        if (ts.isClassDeclaration(node) && node.name?.text === 'HostProfileDomainStore')
          found = node
      })
      if (!found)
        throw new Error('HostProfileDomainStore.ts declares no class HostProfileDomainStore')
      return found
    }

    /** Every method of the class with a body, by name. */
    function methods(): Map<string, ts.MethodDeclaration> {
      const map = new Map<string, ts.MethodDeclaration>()
      for (const member of storeClass().members) {
        if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
          map.set(member.name.text, member)
        }
      }
      if (map.size === 0) throw new Error('HostProfileDomainStore has no methods')
      return map
    }

    function method(name: string): ts.MethodDeclaration {
      const found = methods().get(name)
      if (!found) {
        throw new Error(
          `HostProfileDomainStore declares no method \`${name}\`. It was renamed, moved or ` +
            'deleted — update this closure to the writer that replaced it rather than deleting it.'
        )
      }
      return found
    }

    /** Methods (by name) whose body calls `name(...)` or `this.name(...)`. */
    function callers(name: string): Map<string, ts.CallExpression[]> {
      const found = new Map<string, ts.CallExpression[]>()
      for (const [methodName, declaration] of methods()) {
        const calls = probe.callsTo(declaration.body!, name)
        if (calls.length > 0) found.set(methodName, calls)
      }
      return found
    }

    it('every chat-path atomicJson in the file is the one inside writeThread', () => {
      const all: ts.CallExpression[] = probe.callsTo(probe.source, 'atomicJson')
      expect(all.length).toBeGreaterThan(1)
      const onChatPath = all.filter((call) => probe.argText(call, 0).includes('chatPath('))
      expect(onChatPath).toHaveLength(1)
      const inWriteThread = probe.callsTo(method('writeThread').body!, 'atomicJson')
      expect(inWriteThread).toHaveLength(1)
      expect(inWriteThread[0]).toBe(onChatPath[0])
      // The remaining calls write the workspace records, never a chat file.
      const others = all.filter((call) => call !== onChatPath[0])
      expect(others.length).toBeGreaterThan(0)
      for (const call of others) {
        expect(probe.argText(call, 0)).not.toContain('chat')
      }
    })

    it('writeThread fires the hook after the file is published, with its kind, defaulting to record', () => {
      const declaration = method('writeThread')
      const kind = declaration.parameters[1]
      expect(kind).toBeDefined()
      expect(kind!.initializer && probe.text(kind!.initializer)).toBe("'record'")
      const body = declaration.body!
      const notifies = probe.callsTo(body, 'notifyThreadRecordWritten')
      expect(notifies).toHaveLength(1)
      expect(probe.argText(notifies[0]!, 0)).toBe('thread.appChatId')
      expect(probe.argText(notifies[0]!, 1)).toBe('kind')
      // 13c2: the record it published rides along.
      expect(notifies[0]!.arguments).toHaveLength(3)
      expect(probe.argText(notifies[0]!, 2)).toBe('thread')
      const write = probe.callsTo(body, 'atomicJson')[0]!
      expect(notifies[0]!.getStart()).toBeGreaterThan(write.getEnd())
      // And the notifier reaches the option, guarded so a throw never fails the write.
      const notifier = method('notifyThreadRecordWritten').body!
      const hookCalls = probe.callsTo(notifier, 'onThreadRecordWritten')
      expect(hookCalls).toHaveLength(1)
      let guarded = false
      const visit = (node: ts.Node): void => {
        if (ts.isTryStatement(node) && node.tryBlock.getStart() <= hookCalls[0]!.getStart()) {
          if (hookCalls[0]!.getEnd() <= node.tryBlock.getEnd()) guarded = true
        }
        ts.forEachChild(node, visit)
      }
      visit(notifier)
      expect(guarded).toBe(true)
    })

    it('the writers reaching writeThread are exactly the pinned set, run-port ones marked run', () => {
      const writers = callers('writeThread')
      // `writeThread` calls nothing named writeThread itself; every other
      // caller is a public writer with a behavioural case above.
      expect([...writers.keys()].sort()).toEqual(
        [
          'appendTranscript',
          'archiveThread',
          'configureThread',
          'createThread',
          'persistThreadRecord',
          'recordRunTool',
          'setThreadKind',
          'updateRun'
        ].sort()
      )
      const runPort = new Set(['appendTranscript', 'updateRun', 'recordRunTool'])
      for (const [name, calls] of writers) {
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) {
          if (runPort.has(name)) {
            expect(probe.argText(call, 1)).toBe("'run'")
          } else {
            expect(call.arguments).toHaveLength(1)
          }
        }
      }
    })

    it('the adopt rename is followed by a record notification, and nothing else adopts', () => {
      const adopters = callers('adoptHostThreadRecordTransferArtifact')
      expect([...adopters.keys()]).toEqual(['tryAdoptVerifiedTransfer'])
      const body = method('tryAdoptVerifiedTransfer').body!
      const adopt = adopters.get('tryAdoptVerifiedTransfer')![0]!
      const notifies = probe.callsTo(body, 'notifyThreadRecordWritten')
      expect(notifies).toHaveLength(1)
      expect(probe.argText(notifies[0]!, 0)).toBe('input.threadId')
      expect(probe.argText(notifies[0]!, 1)).toBe("'record'")
      // 13c2: the canonical record the adoption published rides along.
      expect(notifies[0]!.arguments).toHaveLength(3)
      expect(probe.argText(notifies[0]!, 2)).toBe('published')
      expect(notifies[0]!.getStart()).toBeGreaterThan(adopt.getEnd())
    })

    it('the only unlink of a chat file is in deleteThreadRecord, followed by deleted', () => {
      const unlinkers = callers('unlinkSync')
      expect([...unlinkers.keys()]).toEqual(['deleteThreadRecord'])
      const body = method('deleteThreadRecord').body!
      const unlink = unlinkers.get('deleteThreadRecord')!
      expect(unlink).toHaveLength(1)
      expect(probe.argText(unlink[0]!, 0)).toBe('path')
      const notifies = probe.callsTo(body, 'notifyThreadRecordWritten')
      expect(notifies).toHaveLength(1)
      expect(probe.argText(notifies[0]!, 0)).toBe('input.threadId')
      expect(probe.argText(notifies[0]!, 1)).toBe("'deleted'")
      // 13c2: the delete passes no record.
      expect(notifies[0]!.arguments).toHaveLength(2)
      expect(notifies[0]!.getStart()).toBeGreaterThan(unlink[0]!.getEnd())
      // No other class method removes a chat file by another name.
      for (const remover of ['rmSync', 'unlink', 'rm']) {
        expect([...callers(remover).keys()]).toEqual([])
      }
    })

    it('the hook is reached only through notifyThreadRecordWritten, from the three sites', () => {
      const direct = callers('onThreadRecordWritten')
      expect([...direct.keys()]).toEqual(['notifyThreadRecordWritten'])
      const notifiers = callers('notifyThreadRecordWritten')
      expect([...notifiers.keys()].sort()).toEqual(
        ['deleteThreadRecord', 'tryAdoptVerifiedTransfer', 'writeThread'].sort()
      )
    })

    it('the transaction module never reaches the hook', () => {
      // Positive control: the probe is over the transaction's own commit path.
      expect(
        transactionProbe.callsTo(transactionProbe.source, 'commitRename').length
      ).toBeGreaterThan(0)
      expect(transactionProbe.callsTo(transactionProbe.source, 'onThreadRecordWritten')).toEqual([])
      expect(
        transactionProbe.callsTo(transactionProbe.source, 'notifyThreadRecordWritten')
      ).toEqual([])
      expect(transactionProbe.callsTo(transactionProbe.source, 'writeThread')).toEqual([])
    })
  })
})
