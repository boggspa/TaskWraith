import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostDomainDeltaPublisher,
  validateHostDomainEffect,
  validateHostDomainEffectBatch,
  type HostDomainDeltaStorePort,
  type HostDomainEffectDto
} from './HostDomainDeltaPublisher'
import {
  HostDeltaStore,
  HOST_DELTA_FORBIDDEN_PAYLOAD_CODE,
  HOST_DELTA_JOURNAL_FILENAME,
  type HostDeltaAppendInput,
  type HostDeltaAppendResult
} from '../../host-runtime/HostDeltaStore'
import type { HostCursorPosition } from '../../shared/hostProtocol'

describe('HostDomainDeltaPublisher', () => {
  let dataDir: string
  let clock: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-domain-delta-pub-'))
    clock = '2026-08-03T23:00:00.000Z'
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: { compactAfterRecords?: number }) {
    return new HostDeltaStore({
      dataDir,
      now: () => clock,
      compactAfterRecords: options?.compactAfterRecords ?? 1000
    })
  }

  function openPublisher(store?: HostDeltaStore) {
    const s = store ?? openStore()
    return { store: s, publisher: new HostDomainDeltaPublisher({ store: s }) }
  }

  function upsert(
    entityId: string,
    payload: unknown = { title: entityId },
    family: HostDomainEffectDto['family'] = 'thread'
  ): HostDomainEffectDto {
    return { kind: 'upsert', family, entityId, payload }
  }

  it('requires an injected store port', () => {
    expect(() => new HostDomainDeltaPublisher({ store: null as never })).toThrow(/injected/)
    expect(
      () =>
        new HostDomainDeltaPublisher({
          store: { append: undefined as never, getPosition: () => ({ generation: 1, cursor: 0 }) }
        })
    ).toThrow(/append and getPosition/)
  })

  it('publishes ordered upsert/remove/tombstone batch and returns sole-store position', () => {
    const { store, publisher } = openPublisher()
    expect(publisher.getPosition()).toEqual({ generation: 1, cursor: 0 })

    const result = publisher.publish([
      upsert('t1', { title: 'one' }),
      { kind: 'upsert', family: 'run', entityId: 'r1', payload: { status: 'running' } },
      { kind: 'tombstone', family: 'thread', entityId: 't1' },
      { kind: 'remove', family: 'run', entityId: 'r1' }
    ])

    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    expect(result.count).toBe(4)
    expect(result.position).toEqual({ generation: 1, cursor: 4 })
    expect(result.position).toEqual(store.getPosition())
    expect(result.results.map((r) => r.kind)).toEqual([
      'appended',
      'appended',
      'appended',
      'appended'
    ])

    expect(store.getByCursor(1)?.envelope).toMatchObject({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'one' },
      cursor: 1,
      previousCursor: 0
    })
    expect(store.getByCursor(3)?.envelope.tombstone).toBe(true)
    expect(store.getByCursor(4)?.envelope.kind).toBe('remove')
  })

  it('publishes empty batch as success at current store position without journal fork', () => {
    const { store, publisher } = openPublisher()
    store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'pre',
      payload: { title: 'pre' }
    })
    const before = store.getPosition()
    const result = publisher.publish([])
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    expect(result.count).toBe(0)
    expect(result.position).toEqual(before)
    expect(store.getPosition()).toEqual(before)
  })

  it('rejects generation-reset and invalid kinds without appending', () => {
    const { store, publisher } = openPublisher()
    const result = publisher.publish([
      upsert('ok', { title: 'ok' }),
      {
        kind: 'generation-reset',
        family: 'snapshot-meta',
        entityId: 'fence'
      } as HostDomainEffectDto
    ])
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBe('validation_failed')
    expect(result.failures.some((f) => f.reason === 'generation_reset_forbidden')).toBe(true)
    expect(result.position).toEqual({ generation: 1, cursor: 0 })
    expect(store.getPosition().cursor).toBe(0)
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)

    const badKind = publisher.publish([
      { kind: 'mutate', family: 'thread', entityId: 'x' } as never
    ])
    expect(badKind.kind).toBe('rejected')
    if (badKind.kind !== 'rejected') return
    expect(badKind.failures[0]?.reason).toBe('invalid_kind')
  })

  it('requires exact family and bounded non-empty entityId', () => {
    const cases: Array<{ dto: unknown; reason: string }> = [
      {
        dto: { kind: 'upsert', family: 'threads', entityId: 't1', payload: {} },
        reason: 'invalid_family'
      },
      {
        dto: { kind: 'upsert', family: 'THREAD', entityId: 't1', payload: {} },
        reason: 'invalid_family'
      },
      {
        dto: { kind: 'upsert', family: 'thread', entityId: '', payload: {} },
        reason: 'invalid_entity_id'
      },
      {
        dto: { kind: 'upsert', family: 'thread', entityId: '   ', payload: {} },
        reason: 'invalid_entity_id'
      },
      {
        dto: { kind: 'upsert', family: 'thread', entityId: 'e'.repeat(513), payload: {} },
        reason: 'invalid_entity_id'
      },
      { dto: { kind: 'upsert', family: 'thread', payload: {} }, reason: 'invalid_entity_id' }
    ]

    for (const item of cases) {
      const v = validateHostDomainEffect(item.dto, 0)
      expect(v.ok).toBe(false)
      if (v.ok) return
      expect(v.failure.reason).toBe(item.reason)
    }

    const ok = validateHostDomainEffect({
      kind: 'upsert',
      family: 'snapshot-meta',
      entityId: 'e'.repeat(512),
      payload: { k: 1 }
    })
    expect(ok.ok).toBe(true)
  })

  it('requires upsert payload and forbids payload on remove/tombstone', () => {
    const missing = validateHostDomainEffect({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1'
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.failure.reason).toBe('payload_required')

    for (const kind of ['remove', 'tombstone'] as const) {
      const withPayload = validateHostDomainEffect({
        kind,
        family: 'thread',
        entityId: 't1',
        payload: { x: 1 }
      })
      expect(withPayload.ok).toBe(false)
      if (withPayload.ok) return
      expect(withPayload.failure.reason).toBe('payload_forbidden')

      const clean = validateHostDomainEffect({ kind, family: 'thread', entityId: 't1' })
      expect(clean.ok).toBe(true)
    }
  })

  it('validates the full batch before any append (atomic reject)', () => {
    const { store, publisher } = openPublisher()
    const result = publisher.publish([
      upsert('a', { title: 'a' }),
      upsert('b', { title: 'b' }),
      { kind: 'remove', family: 'thread', entityId: 'c', payload: { leak: true } },
      upsert('d', { title: 'd' })
    ])
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ index: 2, reason: 'payload_forbidden' })
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
    expect(store.size).toBe(0)
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)
  })

  it('reports all validation failures in a batch without partial success', () => {
    const validated = validateHostDomainEffectBatch([
      { kind: 'generation-reset', family: 'snapshot-meta', entityId: 'g' },
      { kind: 'upsert', family: 'nope', entityId: 'x', payload: {} },
      { kind: 'tombstone', family: 'thread', entityId: 't', payload: {} }
    ])
    expect(validated.ok).toBe(false)
    if (validated.ok) return
    expect(validated.failures.map((f) => f.reason)).toEqual([
      'generation_reset_forbidden',
      'invalid_family',
      'payload_forbidden'
    ])
  })

  it('rejects forbidden structured payloads before persist and never writes them', () => {
    const { store, publisher } = openPublisher()
    const cases: Array<{ payload: unknown; needle: string }> = [
      { payload: { API_KEY: 'sk-live' }, needle: 'API_KEY' },
      { payload: { nested: { Authorization: 'Bearer x' } }, needle: 'Authorization' },
      { payload: { meta: [{ Thinking: 'hidden' }] }, needle: 'Thinking' },
      { payload: { toolOutput: { stdout: 'secret_token=1' } }, needle: 'toolOutput' },
      { payload: { diff: '--- a\n+++ b\n' }, needle: 'diff' },
      { payload: { messages: [{ role: 'user', text: 'hi' }] }, needle: 'messages' },
      { payload: { fileContent: 'FULL FILE' }, needle: 'fileContent' },
      { payload: { credential: 'under-limit-secret' }, needle: 'credential' }
    ]

    for (const item of cases) {
      const result = publisher.publish([upsert('forbidden', item.payload)])
      expect(result.kind).toBe('rejected')
      if (result.kind !== 'rejected') return
      expect(result.failures[0]?.reason).toBe('forbidden_payload')
      expect(result.failures[0]?.code).toBe(HOST_DELTA_FORBIDDEN_PAYLOAD_CODE)
      expect(result.failures[0]?.detail).toContain(item.needle)
      expect(store.getPosition().cursor).toBe(0)
    }

    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)

    // Safe prose that merely mentions secret words is allowed.
    const ok = publisher.publish([
      upsert('safe', {
        title: 'ok',
        note: 'mentions password token secret only in prose'
      })
    ])
    expect(ok.kind).toBe('published')
    const journal = readFileSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME), 'utf8')
    expect(journal).not.toMatch(/sk-live|Bearer x|secret_token=1|FULL FILE|under-limit-secret/)
  })

  it('oversized safe payload persists digest/length only with no raw prefix', () => {
    const { store, publisher } = openPublisher()
    const bigNote = 'n'.repeat(9000)
    const result = publisher.publish([upsert('big', { title: 'safe-oversize', note: bigNote })])
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return

    const payload = store.getByCursor(1)?.envelope.payload as {
      _truncated?: boolean
      byteLength?: number
      sha256?: string
      preview?: string
      note?: string
    }
    expect(payload).toEqual({
      _truncated: true,
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(payload.preview).toBeUndefined()
    expect(payload.note).toBeUndefined()

    const durable = readFileSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME), 'utf8')
    expect(durable).not.toContain(bigNote.slice(0, 64))
    expect(durable).not.toMatch(/"preview"/)

    // Forbidden + oversize still rejected pre-persist
    const rejected = publisher.publish([upsert('big-forbidden', { transcript: 't'.repeat(9000) })])
    expect(rejected.kind).toBe('rejected')
    if (rejected.kind !== 'rejected') return
    expect(rejected.failures[0]?.reason).toBe('forbidden_payload')
    expect(store.getPosition().cursor).toBe(1)
  })

  it('surfaces partial append honestly when store rejects mid-batch', () => {
    const real = openStore()
    let call = 0
    const port: HostDomainDeltaStorePort = {
      getPosition: () => real.getPosition(),
      append: (input: HostDeltaAppendInput): HostDeltaAppendResult => {
        call += 1
        if (call === 3) {
          return {
            kind: 'rejected',
            reason: 'invalid_envelope',
            detail: 'simulated mid-batch rejection',
            position: real.getPosition()
          }
        }
        return real.append(input)
      }
    }
    const publisher = new HostDomainDeltaPublisher({ store: port })
    const result = publisher.publish([upsert('a'), upsert('b'), upsert('c'), upsert('d')])

    expect(result.kind).toBe('partial')
    if (result.kind !== 'partial') return
    expect(result.publishedCount).toBe(2)
    expect(result.failedAtIndex).toBe(2)
    expect(result.failure.kind).toBe('append_rejected')
    expect(result.position).toEqual({ generation: 1, cursor: 2 })
    expect(result.position).toEqual(real.getPosition())
    expect(result.results).toHaveLength(2)
    // Must not claim full success; d was never appended
    expect(real.getByCursor(3)).toBeNull()
    expect(real.getByCursor(4)).toBeNull()
  })

  it('surfaces store throw as partial with sole-store position (no fabricated cursor)', () => {
    const real = openStore()
    real.append({ kind: 'upsert', family: 'thread', entityId: 'seed', payload: { n: 1 } })
    let call = 0
    const port: HostDomainDeltaStorePort = {
      getPosition: () => real.getPosition(),
      append: (input) => {
        call += 1
        if (call === 2) {
          throw new Error('disk full')
        }
        return real.append(input)
      }
    }
    const publisher = new HostDomainDeltaPublisher({ store: port })
    const result = publisher.publish([upsert('a'), upsert('b'), upsert('c')])
    expect(result.kind).toBe('partial')
    if (result.kind !== 'partial') return
    expect(result.publishedCount).toBe(1)
    expect(result.failedAtIndex).toBe(1)
    expect(result.failure).toEqual({ kind: 'store_error', detail: 'disk full' })
    expect(result.position).toEqual(real.getPosition())
    expect(result.position.cursor).toBe(2) // seed + a
  })

  it('fails closed when getPosition throws before validation append', () => {
    const port: HostDomainDeltaStorePort = {
      getPosition: () => {
        throw new Error('position unavailable')
      },
      append: () => {
        throw new Error('should not append')
      }
    }
    const publisher = new HostDomainDeltaPublisher({ store: port })
    const result = publisher.publish([upsert('a')])
    expect(result.kind).toBe('store_error')
    if (result.kind !== 'store_error') return
    expect(result.detail).toContain('position unavailable')
    expect(result.position).toBeNull()
  })

  it('never fabricates position — published position equals store.getPosition()', () => {
    const positions: HostCursorPosition[] = []
    const real = openStore()
    const port: HostDomainDeltaStorePort = {
      getPosition: () => {
        const p = real.getPosition()
        positions.push({ ...p })
        return p
      },
      append: (input) => real.append(input)
    }
    const publisher = new HostDomainDeltaPublisher({ store: port })
    const result = publisher.publish([
      upsert('x'),
      { kind: 'remove', family: 'thread', entityId: 'x' }
    ])
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    expect(result.position).toEqual(real.getPosition())
    // Final published position came from store, not publisher arithmetic
    expect(positions.at(-1)).toEqual(result.position)
    expect(result.position).toEqual({ generation: 1, cursor: 2 })
  })

  it('preserves append order and cursor chain across families', () => {
    const { store, publisher } = openPublisher()
    const families = [
      'workspace',
      'thread',
      'run',
      'mission',
      'round',
      'participant',
      'provider',
      'routing',
      'question',
      'approval',
      'schedule',
      'usage',
      'artifact',
      'warning',
      'recovery',
      'health',
      'snapshot-meta'
    ] as const

    const effects: HostDomainEffectDto[] = families.map((family, i) => ({
      kind: 'upsert',
      family,
      entityId: `e-${i}`,
      payload: { i }
    }))
    const result = publisher.publish(effects)
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    expect(result.count).toBe(families.length)

    for (let i = 0; i < families.length; i += 1) {
      const env = store.getByCursor(i + 1)?.envelope
      expect(env?.family).toBe(families[i])
      expect(env?.entityId).toBe(`e-${i}`)
      expect(env?.cursor).toBe(i + 1)
      expect(env?.previousCursor).toBe(i)
    }
  })

  it('does not import or call domain observers / command stores', () => {
    // Structural: publisher module surface is validation + store port only.
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostDomainDeltaPublisher.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/HostCommandReceipt|EnsembleOrchestrator|AppStore|domainObserver/)
    expect(source).not.toMatch(/from '\.\.\/index'|from '\.\/HostCommand/)
  })

  it('duplicate store responses are not treated as full failure', () => {
    const real = openStore()
    const port: HostDomainDeltaStorePort = {
      getPosition: () => real.getPosition(),
      append: (input) => {
        const first = real.append(input)
        if (first.kind !== 'appended') return first
        // Simulate exact-duplicate acknowledgement shape without advancing again
        return {
          kind: 'duplicate',
          record: first.record,
          position: real.getPosition()
        }
      }
    }
    const publisher = new HostDomainDeltaPublisher({ store: port })
    const result = publisher.publish([upsert('dup')])
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') return
    expect(result.results[0]?.kind).toBe('duplicate')
    expect(result.position).toEqual(real.getPosition())
  })

  it('rejects non-array effects without store mutation', () => {
    const { store, publisher } = openPublisher()
    const result = publisher.publish(null as never)
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.failures[0]?.detail).toMatch(/array/)
    expect(store.getPosition().cursor).toBe(0)
  })
})
