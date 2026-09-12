import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostCommand
} from '../shared/hostProtocol'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { createWorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'
import {
  HostProfileRecordCommandExecutor,
  isHostProfileRecordMutationName
} from './HostProfileRecordCommandExecutor'
import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-profile-record-executor-'))
  profiles.push(path)
  return path
}

function command(
  name: HostCommand['name'],
  target: HostCommand['target'],
  argumentsValue: HostCommand['arguments']
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: `test:${name}`,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    name,
    target,
    arguments: argumentsValue,
    issuedAt: '2026-08-28T10:00:00.000Z'
  }
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('HostProfileRecordCommandExecutor', () => {
  it('recognizes only the five Host-owned profile record mutations', () => {
    for (const name of [
      'thread.record.persist',
      'thread.record.delete',
      'workspace.record.upsert',
      'workspace.record.remove',
      'workspace.records.clear'
    ] as const) {
      expect(isHostProfileRecordMutationName(name)).toBe(true)
    }
    expect(isHostProfileRecordMutationName('composer.send')).toBe(false)
  })

  it('consumes a transfer artifact and durably persists the complete thread record', () => {
    const profilePath = profile()
    const authority = { assertProfileAuthority: vi.fn() }
    const store = new HostProfileDomainStore({ profilePath, authority, now: () => 200 })
    const executor = new HostProfileRecordCommandExecutor({ profilePath, store })
    const record = {
      appChatId: 'thread-1',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: profilePath,
      title: 'Ensemble',
      archived: false,
      messages: [],
      updatedAt: 100,
      ensemble: {
        participants: [
          {
            id: 'seat-1',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: 'Work',
            order: 0
          }
        ]
      }
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'transfer-1',
      record
    })

    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-1' },
          {
            ...descriptor,
            expectedRevision: 0
          }
        )
      )
    ).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })
    expect(store.getThread('thread-1')).toMatchObject({
      appChatId: 'thread-1',
      persistenceRevision: 0,
      ensemble: record.ensemble
    })
    expect(authority.assertProfileAuthority).toHaveBeenCalled()
  })

  it('emits a durable_commit span after a successful persist', () => {
    const profilePath = profile()
    const authority = { assertProfileAuthority: vi.fn() }
    const store = new HostProfileDomainStore({ profilePath, authority, now: () => 200 })
    let clock = 1000
    const recorder = createWorkSpanRecorder({ process: 'host', maxRetained: 16, now: () => clock })
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      workSpanRecorder: recorder,
      now: () => (clock += 5)
    })
    const record = {
      appChatId: 'thread-1',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: profilePath,
      title: 'Ensemble',
      archived: false,
      messages: [],
      updatedAt: 100,
      ensemble: {
        participants: [
          {
            id: 'seat-1',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: 'Work',
            order: 0
          }
        ]
      }
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'transfer-span-1',
      record
    })
    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-1' },
          { ...descriptor, expectedRevision: 0 }
        )
      )
    ).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })
    const snapshot = recorder.snapshot()
    expect(snapshot.spans).toHaveLength(1)
    expect(snapshot.spans[0]).toMatchObject({
      chatId: 'thread-1',
      runId: '11111111-1111-4111-8111-111111111111',
      kind: 'durable_commit',
      resource: 'host_chain',
      process: 'host'
    })
    expect(snapshot.spans[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('does not emit durable_commit when the transfer is missing', () => {
    const profilePath = profile()
    const recorder = createWorkSpanRecorder({ process: 'host', maxRetained: 8 })
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store: {
        upsertWorkspaceRecord: vi.fn(),
        removeWorkspaceRecord: vi.fn(),
        clearWorkspaceRecords: vi.fn(),
        deleteThreadRecord: vi.fn(),
        persistThreadRecord: vi.fn()
      },
      workSpanRecorder: recorder
    })
    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-1' },
          {
            transferId: 'missing-transfer',
            sha256: 'a'.repeat(64),
            byteLength: 10,
            expectedRevision: 0
          }
        )
      )
    ).toEqual({ status: 'failed', errorCode: 'thread_record_transfer_missing' })
    expect(recorder.snapshot().spans).toEqual([])
  })

  it('contains a throwing recorder so persist still succeeds', () => {
    const profilePath = profile()
    const authority = { assertProfileAuthority: vi.fn() }
    const store = new HostProfileDomainStore({ profilePath, authority, now: () => 200 })
    const throwing = createWorkSpanRecorder({ process: 'host', maxRetained: 8 })
    throwing.record = () => {
      throw new Error('recorder must not break persist')
    }
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      workSpanRecorder: throwing
    })
    const record = {
      appChatId: 'thread-2',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: profilePath,
      title: 'Ensemble',
      archived: false,
      messages: [],
      updatedAt: 100,
      ensemble: {
        participants: [
          {
            id: 'seat-1',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: 'Work',
            order: 0
          }
        ]
      }
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'transfer-throw-1',
      record
    })
    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-2' },
          { ...descriptor, expectedRevision: 0 }
        )
      )
    ).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })
  })

  it('returns the stable transfer-missing code before touching the store', () => {
    const profilePath = profile()
    const persistThreadRecord = vi.fn()
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store: {
        upsertWorkspaceRecord: vi.fn(),
        removeWorkspaceRecord: vi.fn(),
        clearWorkspaceRecords: vi.fn(),
        deleteThreadRecord: vi.fn(),
        persistThreadRecord
      }
    })

    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-1' },
          {
            transferId: 'missing-transfer',
            sha256: 'a'.repeat(64),
            byteLength: 10,
            expectedRevision: 0
          }
        )
      )
    ).toEqual({ status: 'failed', errorCode: 'thread_record_transfer_missing' })
    expect(persistThreadRecord).not.toHaveBeenCalled()
  })

  it('hands the verified artifact to the store and cleans it up after a non-adopting persist', () => {
    const profilePath = profile()
    const record = {
      appChatId: 'thread-1',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: profilePath,
      title: 'Echo base',
      archived: false,
      messages: [],
      updatedAt: 100,
      persistenceRevision: 0
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'transfer-handoff-1',
      record
    })
    const persistThreadRecord = vi.fn(() => ({}) as never)
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store: {
        upsertWorkspaceRecord: vi.fn(),
        removeWorkspaceRecord: vi.fn(),
        clearWorkspaceRecords: vi.fn(),
        deleteThreadRecord: vi.fn(),
        persistThreadRecord
      }
    })

    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: 'thread-1' },
          { ...descriptor, expectedRevision: 0 }
        )
      )
    ).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })

    // The store receives the verified artifact reference so a stamped-ahead
    // record can be adopted by rename instead of re-serialized. Removing the
    // handoff breaks this assertion while the legacy consume path still
    // passes every other test in the file.
    expect(persistThreadRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        expectedRevision: 0,
        verifiedTransfer: expect.objectContaining({
          byteLength: descriptor.byteLength,
          path: expect.any(String),
          identity: expect.objectContaining({ dev: expect.any(String), ino: expect.any(String) })
        })
      })
    )
    // A store that did not adopt must not leave the owner-only artifact
    // behind; cleanup is the executor's, best-effort, and idempotent.
    expect(existsSync(join(profilePath, 'host-thread-record-transfer', 'transfer-handoff-1.record.json'))).toBe(
      false
    )
  })

  it('adopts a stamped-ahead transfer end to end: artifact gone, chat file is the artifact bytes', () => {
    const profilePath = profile()
    const authority = { assertProfileAuthority: vi.fn() }
    const store = new HostProfileDomainStore({ profilePath, authority, now: () => 200 })
    const executor = new HostProfileRecordCommandExecutor({ profilePath, store })
    const created = store.createThread({ scope: 'global', title: 'Before' })
    const record = {
      ...created,
      title: 'Stamped ahead',
      messages: [
        {
          id: 'm1',
          role: 'user' as const,
          content: 'body',
          timestamp: '2026-09-12T00:00:00.000Z'
        }
      ],
      updatedAt: 100,
      persistenceRevision: 1
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'transfer-adopt-e2e',
      record
    })

    expect(
      executor.execute(
        command(
          'thread.record.persist',
          { threadId: created.appChatId },
          { ...descriptor, expectedRevision: 0 }
        )
      )
    ).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })

    expect(readdirSync(join(profilePath, 'host-thread-record-transfer'))).toEqual([])
    expect(readFileSync(join(profilePath, 'chats', `${created.appChatId}.json`), 'utf8')).toBe(
      `${JSON.stringify(record)}\n`
    )
    expect(store.getThread(created.appChatId)).toMatchObject({
      title: 'Stamped ahead',
      persistenceRevision: 1
    })
  })
})
