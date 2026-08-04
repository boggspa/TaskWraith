import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand
} from '../../shared/hostProtocol'
import {
  HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME,
  HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME,
  HostDeferredCommandEnvelopeStore,
  type HostDeferredCommandEnvelopePutInput
} from './HostDeferredCommandEnvelopeStore'
import { fingerprintHostCommand } from './HostCommandFingerprint'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}
const OTHER_ACTOR: HostActorIdentity = {
  actorId: 'actor-2',
  clientId: 'client-2',
  clientClass: 'desktop'
}

const COMMAND_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111112',
  '11111111-1111-4111-8111-111111111113',
  '11111111-1111-4111-8111-111111111114'
] as const
const IDEMPOTENCY_UUIDS = [
  '22222222-2222-4222-8222-222222222221',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222223',
  '22222222-2222-4222-8222-222222222224'
] as const
const DEFERRED_IDS = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-333333333334'
] as const
const CHALLENGE_IDS = [
  '44444444-4444-4444-8444-444444444441',
  '44444444-4444-4444-8444-444444444442',
  '44444444-4444-4444-8444-444444444443',
  '44444444-4444-4444-8444-444444444444'
] as const
const SECRET_TEXT = 'restart-safe private composer text'

function command(options?: {
  commandId?: string
  idempotencyUuid?: string
  actor?: HostActorIdentity
  text?: string
  name?: HostCommand['name']
}): HostCommand {
  const actor = options?.actor ?? ACTOR
  const name = options?.name ?? 'composer.send'
  const base: HostCommand = {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: options?.commandId ?? COMMAND_IDS[0],
    idempotencyKey:
      actor.clientClass +
      ':' +
      actor.clientId +
      ':' +
      (options?.idempotencyUuid ?? IDEMPOTENCY_UUIDS[0]),
    actor,
    name,
    target: name === 'ping' ? {} : { threadId: 'thread-1' },
    arguments: name === 'ping' ? {} : { text: options?.text ?? SECRET_TEXT },
    issuedAt: '2026-08-04T02:00:00.000Z'
  }
  return base
}

function putInput(
  hostCommand: HostCommand = command(),
  options?: {
    deferredId?: string
    challengeId?: string
    challengeKind?: 'approval' | 'question'
  }
): HostDeferredCommandEnvelopePutInput {
  return {
    deferredId: options?.deferredId ?? DEFERRED_IDS[0],
    challengeId: options?.challengeId ?? CHALLENGE_IDS[0],
    challengeKind: options?.challengeKind ?? 'approval',
    commandFingerprint: fingerprintHostCommand(hostCommand).fingerprint,
    command: hostCommand
  }
}

describe('HostDeferredCommandEnvelopeStore', () => {
  let dataDir: string
  let tick: number
  let logs: string[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-deferred-envelope-'))
    tick = 0
    logs = []
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function open(options?: {
    maxRecords?: number
    compactAfterRecords?: number
  }): HostDeferredCommandEnvelopeStore {
    return new HostDeferredCommandEnvelopeStore({
      dataDir,
      now: () => new Date(Date.UTC(2026, 7, 4, 2, 0, tick++)).toISOString(),
      log: (line) => logs.push(line),
      ...options
    })
  }

  it('persists a canonical command privately and exposes only actor-bound body access', () => {
    const store = open()
    const input = putInput()

    expect(store.put(input)).toEqual({ kind: 'created' })
    const found = store.getByDeferredId(input.deferredId, ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.record.command).toEqual(input.command)
    expect(found.record.commandFingerprint).toBe(input.commandFingerprint)

    const crossActor = store.getByDeferredId(input.deferredId, OTHER_ACTOR)
    expect(crossActor).toEqual({ kind: 'actor_mismatch' })
    expect(JSON.stringify(crossActor)).not.toContain(SECRET_TEXT)

    const recovery = store.getRecoverySummary()
    expect(recovery).toEqual({
      size: 1,
      stored: 1,
      consumed: 0,
      quarantined: 0,
      storedCommandIds: [COMMAND_IDS[0]],
      quarantinedCommandIds: []
    })
    expect(JSON.stringify(recovery)).not.toContain(SECRET_TEXT)
    expect(JSON.stringify(recovery)).not.toContain('thread-1')

    const journalPath = join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME)
    expect(statSync(journalPath).mode & 0o777).toBe(0o600)
    store.compact()
    const checkpointPath = join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME)
    expect(statSync(checkpointPath).mode & 0o777).toBe(0o600)
  })

  it('reopens and compacts without losing exact command or lifecycle state', () => {
    const first = open({ compactAfterRecords: 1 })
    const input = putInput()
    expect(first.put(input)).toEqual({ kind: 'created' })

    const reopened = open({ compactAfterRecords: 1 })
    const found = reopened.getByCommandId(COMMAND_IDS[0], ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.record.state).toBe('stored')
    expect(found.record.command?.arguments).toEqual({ text: SECRET_TEXT })

    expect(reopened.markConsumed(DEFERRED_IDS[0], ACTOR)).toEqual({
      kind: 'updated',
      state: 'consumed'
    })
    reopened.compact()

    const again = open()
    const terminal = again.getByDeferredId(DEFERRED_IDS[0], ACTOR)
    expect(terminal.kind).toBe('found')
    if (terminal.kind !== 'found') return
    expect(terminal.record.state).toBe('consumed')
    expect(terminal.record.command?.arguments).toEqual({ text: SECRET_TEXT })
  })

  it('recovers valid rows around corrupt interior and truncated journal tails', () => {
    const first = open()
    expect(first.put(putInput())).toEqual({ kind: 'created' })

    const journalPath = join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME)
    appendFileSync(journalPath, '{not-json}\n', 'utf8')

    const secondCommand = command({
      commandId: COMMAND_IDS[1],
      idempotencyUuid: IDEMPOTENCY_UUIDS[1],
      text: 'second command'
    })
    expect(
      first.put(
        putInput(secondCommand, {
          deferredId: DEFERRED_IDS[1],
          challengeId: CHALLENGE_IDS[1]
        })
      )
    ).toEqual({ kind: 'created' })

    appendFileSync(journalPath, '{"op":"upsert"', 'utf8')

    const reopened = open()
    expect(reopened.size).toBe(2)
    expect(reopened.getByCommandId(COMMAND_IDS[0], ACTOR).kind).toBe('found')
    expect(reopened.getByCommandId(COMMAND_IDS[1], ACTOR).kind).toBe('found')
    expect(logs.some((line) => line.includes('skipped corrupt journal line'))).toBe(true)
    expect(logs.some((line) => line.includes('dropped truncated journal tail'))).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(SECRET_TEXT)
  })

  it('makes exact repeats idempotent and rejects every identity collision', () => {
    const store = open()
    const original = putInput()
    expect(store.put(original)).toEqual({ kind: 'created' })
    expect(store.put(original)).toEqual({ kind: 'existing' })

    const changedSameDeferred = command({ text: 'different content' })
    expect(store.put(putInput(changedSameDeferred))).toEqual({
      kind: 'conflict',
      code: 'deferred_id_collision'
    })

    expect(
      store.put(
        putInput(command(), {
          deferredId: DEFERRED_IDS[1],
          challengeId: CHALLENGE_IDS[1]
        })
      )
    ).toEqual({ kind: 'conflict', code: 'command_id_collision' })

    const sameKey = command({
      commandId: COMMAND_IDS[1],
      idempotencyUuid: IDEMPOTENCY_UUIDS[0],
      text: 'same idempotency key'
    })
    expect(
      store.put(
        putInput(sameKey, {
          deferredId: DEFERRED_IDS[1],
          challengeId: CHALLENGE_IDS[1]
        })
      )
    ).toEqual({ kind: 'conflict', code: 'idempotency_key_collision' })

    const sameChallenge = command({
      commandId: COMMAND_IDS[2],
      idempotencyUuid: IDEMPOTENCY_UUIDS[2],
      text: 'same challenge'
    })
    expect(
      store.put(
        putInput(sameChallenge, {
          deferredId: DEFERRED_IDS[2],
          challengeId: CHALLENGE_IDS[0]
        })
      )
    ).toEqual({ kind: 'conflict', code: 'challenge_id_collision' })
  })

  it('fails closed on unknown fields, malformed identity, routing, actor and fingerprint', () => {
    const store = open()
    const valid = putInput()

    expect(store.put({ ...valid, unknown: SECRET_TEXT })).toEqual({
      kind: 'invalid',
      code: 'invalid_input'
    })
    expect(
      store.put({
        ...valid,
        deferredId: 'not-a-uuid'
      })
    ).toEqual({ kind: 'invalid', code: 'invalid_identity' })
    expect(
      store.put({
        ...valid,
        commandFingerprint: 'a'.repeat(64)
      })
    ).toEqual({ kind: 'invalid', code: 'fingerprint_mismatch' })

    const actorMismatch = command({
      actor: OTHER_ACTOR,
      idempotencyUuid: IDEMPOTENCY_UUIDS[1]
    })
    actorMismatch.idempotencyKey = 'desktop:' + ACTOR.clientId + ':' + IDEMPOTENCY_UUIDS[1]
    expect(store.put(putInput(actorMismatch))).toEqual({
      kind: 'invalid',
      code: 'invalid_identity'
    })

    const reserved = command({ name: 'ping' })
    expect(store.put(putInput(reserved))).toEqual({
      kind: 'invalid',
      code: 'invalid_routing'
    })

    const commandWithUnknown = {
      ...command(),
      unexpected: SECRET_TEXT
    }
    expect(
      store.put({
        ...valid,
        command: commandWithUnknown,
        commandFingerprint: fingerprintHostCommand(command()).fingerprint
      })
    ).toEqual({ kind: 'invalid', code: 'invalid_command' })
    expect(store.size).toBe(0)
  })

  it('quarantines persisted tamper without retaining or projecting the command body', () => {
    const first = open()
    const input = putInput()
    expect(first.put(input)).toEqual({ kind: 'created' })
    first.compact()

    const checkpointPath = join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME)
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      records: Array<Record<string, unknown>>
    }
    checkpoint.records[0].unexpected = SECRET_TEXT
    writeFileSync(checkpointPath, JSON.stringify(checkpoint) + '\n', 'utf8')

    const reopened = open()
    const found = reopened.getByDeferredId(DEFERRED_IDS[0], ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.record.state).toBe('quarantined')
    expect(found.record.quarantineCode).toBe('corrupt_record')
    expect(found.record.command).toBeUndefined()
    expect(JSON.stringify(found.record)).not.toContain(SECRET_TEXT)
    expect(reopened.getRecoverySummary()).toMatchObject({
      size: 1,
      stored: 0,
      quarantined: 1,
      quarantinedCommandIds: [COMMAND_IDS[0]]
    })

    const malformedSchema = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<
      string,
      unknown
    >
    malformedSchema.schemaVersion = 99
    writeFileSync(checkpointPath, JSON.stringify(malformedSchema) + '\n', 'utf8')
    const schemaRejected = open()
    expect(schemaRejected.size).toBe(0)
    expect(JSON.stringify(logs)).not.toContain(SECRET_TEXT)
  })

  it('makes terminal transitions idempotent and never revives a quarantined row', () => {
    const consumed = open()
    expect(consumed.put(putInput())).toEqual({ kind: 'created' })
    expect(consumed.markConsumed(DEFERRED_IDS[0], ACTOR)).toEqual({
      kind: 'updated',
      state: 'consumed'
    })
    expect(consumed.markConsumed(DEFERRED_IDS[0], ACTOR)).toEqual({
      kind: 'existing',
      state: 'consumed'
    })
    expect(consumed.markQuarantined(DEFERRED_IDS[0], ACTOR, 'verification_failed')).toEqual({
      kind: 'state_conflict',
      state: 'consumed'
    })

    rmSync(dataDir, { recursive: true, force: true })
    dataDir = mkdtempSync(join(tmpdir(), 'host-deferred-envelope-'))
    const quarantined = open()
    expect(quarantined.put(putInput())).toEqual({ kind: 'created' })
    expect(quarantined.markQuarantined(DEFERRED_IDS[0], ACTOR, 'verification_failed')).toEqual({
      kind: 'updated',
      state: 'quarantined'
    })
    expect(quarantined.markQuarantined(DEFERRED_IDS[0], ACTOR, 'verification_failed')).toEqual({
      kind: 'existing',
      state: 'quarantined'
    })
    expect(quarantined.markQuarantined(DEFERRED_IDS[0], ACTOR, 'fingerprint_mismatch')).toEqual({
      kind: 'state_conflict',
      state: 'quarantined'
    })
    expect(quarantined.markConsumed(DEFERRED_IDS[0], ACTOR)).toEqual({
      kind: 'state_conflict',
      state: 'quarantined'
    })
    expect(quarantined.put(putInput())).toEqual({
      kind: 'conflict',
      code: 'deferred_id_collision'
    })
  })

  it('evicts only consumed rows and reports store_full for protected capacity', () => {
    const store = open({ maxRecords: 2 })
    expect(store.put(putInput())).toEqual({ kind: 'created' })
    expect(store.markQuarantined(DEFERRED_IDS[0], ACTOR, 'verification_failed')).toEqual({
      kind: 'updated',
      state: 'quarantined'
    })

    const second = command({
      commandId: COMMAND_IDS[1],
      idempotencyUuid: IDEMPOTENCY_UUIDS[1],
      text: 'second stored'
    })
    expect(
      store.put(
        putInput(second, {
          deferredId: DEFERRED_IDS[1],
          challengeId: CHALLENGE_IDS[1]
        })
      )
    ).toEqual({ kind: 'created' })

    const third = command({
      commandId: COMMAND_IDS[2],
      idempotencyUuid: IDEMPOTENCY_UUIDS[2],
      text: 'third blocked'
    })
    expect(
      store.put(
        putInput(third, {
          deferredId: DEFERRED_IDS[2],
          challengeId: CHALLENGE_IDS[2]
        })
      )
    ).toEqual({ kind: 'store_full' })
    store.compact()
    expect(store.getRecoverySummary()).toMatchObject({
      size: 2,
      stored: 1,
      quarantined: 1
    })

    rmSync(dataDir, { recursive: true, force: true })
    dataDir = mkdtempSync(join(tmpdir(), 'host-deferred-envelope-'))
    const recyclable = open({ maxRecords: 2 })
    expect(recyclable.put(putInput())).toEqual({ kind: 'created' })
    expect(recyclable.markConsumed(DEFERRED_IDS[0], ACTOR).kind).toBe('updated')
    expect(
      recyclable.put(
        putInput(second, {
          deferredId: DEFERRED_IDS[1],
          challengeId: CHALLENGE_IDS[1]
        })
      )
    ).toEqual({ kind: 'created' })
    expect(
      recyclable.put(
        putInput(third, {
          deferredId: DEFERRED_IDS[2],
          challengeId: CHALLENGE_IDS[2]
        })
      )
    ).toEqual({ kind: 'created' })
    expect(recyclable.getByDeferredId(DEFERRED_IDS[0], ACTOR)).toEqual({
      kind: 'not_found'
    })
    expect(recyclable.getRecoverySummary()).toMatchObject({
      size: 2,
      stored: 2,
      consumed: 0
    })
  })

  it('keeps serialized failures and compact outputs free of raw command content', () => {
    const store = open()
    const original = putInput()
    expect(store.put(original)).toEqual({ kind: 'created' })

    const collision = store.put(
      putInput(command({ text: 'a different private body' }), {
        deferredId: DEFERRED_IDS[0],
        challengeId: CHALLENGE_IDS[0]
      })
    )
    const invalid = store.put({ ...original, injected: SECRET_TEXT })
    const crossActor = store.getByCommandId(COMMAND_IDS[0], OTHER_ACTOR)
    const compact = store.getRecoverySummary()

    for (const output of [collision, invalid, crossActor, compact]) {
      const serialized = JSON.stringify(output)
      expect(serialized).not.toContain(SECRET_TEXT)
      expect(serialized).not.toContain('a different private body')
      expect(serialized).not.toContain('thread-1')
    }
  })

  it('keeps checkpoint and journal paths bounded to the injected data directory', () => {
    const store = open()
    expect(store.put(putInput())).toEqual({ kind: 'created' })

    expect(existsSync(join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME))).toBe(true)
    store.compact()
    expect(existsSync(join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME))).toBe(true)
    expect(existsSync(join(dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME))).toBe(false)
  })
})
