import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditContentHash,
  boundedAuditPreview,
  capAuditEvents,
  HumanCollaborationAuditLog,
  MAX_HUMAN_COLLABORATION_AUDIT_EVENTS,
  type HumanCollaborationAuditEvent
} from './HumanCollaborationAuditLog'

/*
 * Phase 2 (P2a) — pins the audit log's safety properties: BOUNDED persistence
 * (the write is a synchronous full rewrite, so the cap is load-bearing),
 * redacted/truncated previews (never raw collaborator content), and a
 * self-healing reload.
 */
describe('HumanCollaborationAuditLog', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collab-audit-'))
    path = join(dir, 'audit.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends durable rows and lists them newest-first', () => {
    const log = new HumanCollaborationAuditLog(path)
    log.append({ kind: 'share.created', chatId: 'chat-1', shareId: 's-1' })
    log.append({ kind: 'contribution.received', chatId: 'chat-1', shareId: 's-1', preview: 'hello' })

    const rows = log.list()
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('contribution.received')
    expect(rows[1].kind).toBe('share.created')
    expect(rows[0].id).toBeTruthy()
    expect(rows[0].at).toBeGreaterThan(0)

    // Survives a reload from disk.
    const reloaded = new HumanCollaborationAuditLog(path)
    expect(reloaded.list()).toHaveLength(2)
  })

  it('filters by chat and bounds the list limit', () => {
    const log = new HumanCollaborationAuditLog(path)
    log.append({ kind: 'share.created', chatId: 'a' })
    log.append({ kind: 'share.created', chatId: 'b' })
    log.append({ kind: 'share.revoked', chatId: 'a' })
    expect(log.list({ chatId: 'a' })).toHaveLength(2)
    expect(log.list({ chatId: 'a', limit: 1 })).toHaveLength(1)
    expect(log.list({ chatId: 'a', limit: 1 })[0].kind).toBe('share.revoked')
  })

  it('caps the stored events so the sync rewrite stays bounded', () => {
    const events = Array.from({ length: MAX_HUMAN_COLLABORATION_AUDIT_EVENTS + 50 }, (_, i) => ({
      id: `e${i}`,
      at: i,
      kind: 'contribution.received'
    })) as HumanCollaborationAuditEvent[]
    const capped = capAuditEvents(events)
    expect(capped).toHaveLength(MAX_HUMAN_COLLABORATION_AUDIT_EVENTS)
    // Oldest dropped, newest kept.
    expect(capped[0].id).toBe('e50')
    expect(capped[capped.length - 1].id).toBe(`e${MAX_HUMAN_COLLABORATION_AUDIT_EVENTS + 49}`)
  })

  it('never stores raw collaborator content: previews are redacted + truncated', () => {
    const log = new HumanCollaborationAuditLog(path)
    const secret = `please use sk-abcdefghijklmnop and AWS_SECRET_ACCESS_KEY=deadbeef ${'x'.repeat(500)}`
    log.append({ kind: 'contribution.received', chatId: 'c', preview: secret })
    const [row] = log.list()
    expect(row.preview).not.toContain('sk-abcdefghijklmnop')
    expect(row.preview).not.toContain('deadbeef')
    expect(row.preview!.length).toBeLessThanOrEqual(121 + '[redacted-key]'.length)
    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).not.toContain('sk-abcdefghijklmnop')
  })

  it('boundedAuditPreview flattens whitespace and truncates', () => {
    expect(boundedAuditPreview('a\n\nb\tc')).toBe('a b c')
    expect(boundedAuditPreview('y'.repeat(300)).length).toBe(121)
  })

  it('auditContentHash is stable and bounded', () => {
    expect(auditContentHash('hello')).toBe(auditContentHash('hello'))
    expect(auditContentHash('hello')).not.toBe(auditContentHash('world'))
    expect(auditContentHash('hello').length).toBeLessThanOrEqual(16)
  })

  it('self-heals a corrupted file on load', () => {
    const log = new HumanCollaborationAuditLog(path)
    log.append({ kind: 'share.created', chatId: 'a' })
    // Corrupt the file, then reload.
    const broken = new HumanCollaborationAuditLog(join(dir, 'missing.json'))
    expect(broken.list()).toEqual([])
  })

  it('purges rows for erased chats and shares, including chatless share rows', () => {
    const log = new HumanCollaborationAuditLog(path)
    log.append({ kind: 'share.created', chatId: 'chat-erased', shareId: 's-erased' })
    log.append({ kind: 'contribution.received', chatId: 'chat-erased', preview: 'secret text' })
    // Admission rows carry only the share id — share-id matching must reach them.
    log.append({ kind: 'admission.began', shareId: 's-erased', collaboratorId: 'c-1' })
    log.append({ kind: 'share.created', chatId: 'chat-live', shareId: 's-live' })

    expect(
      log.purgeEntries({ chatIds: ['chat-erased'], shareIds: ['s-erased'] })
    ).toBe(3)
    expect(log.purgeEntries({ chatIds: ['chat-erased'], shareIds: ['s-erased'] })).toBe(0)
    const rows = log.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].chatId).toBe('chat-live')
    // The durable file dropped the erased rows too.
    expect(readFileSync(path, 'utf8')).not.toContain('chat-erased')

    expect(log.purgeAll()).toBe(1)
    expect(log.list()).toEqual([])
    expect(new HumanCollaborationAuditLog(path).list()).toEqual([])
  })
})
