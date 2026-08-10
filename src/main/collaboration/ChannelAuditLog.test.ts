import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capChannelAuditEvents,
  ChannelAuditLog,
  MAX_CHANNEL_AUDIT_EVENTS,
  type ChannelAuditEvent
} from './ChannelAuditLog'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('ChannelAuditLog', () => {
  it('keeps only the newest bounded events', () => {
    const events = Array.from(
      { length: MAX_CHANNEL_AUDIT_EVENTS + 2 },
      (_, index) =>
        ({
          id: String(index),
          at: index,
          kind: 'protocol.rejected'
        }) satisfies ChannelAuditEvent
    )
    const capped = capChannelAuditEvents(events)
    expect(capped).toHaveLength(MAX_CHANNEL_AUDIT_EVENTS)
    expect(capped[0]?.id).toBe('2')
  })

  it('persists bounded evidence without message bodies', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-audit-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'audit.json')
    const log = new ChannelAuditLog(path)
    log.append({
      kind: 'message.accepted',
      channelId: 'channel',
      memberId: 'member',
      contentHash: 'a'.repeat(64),
      detail: `token=super-secret-value /Users/alice/private ${'x'.repeat(400)}`,
      at: 123
    })

    expect(new ChannelAuditLog(path).list()).toEqual([
      expect.objectContaining({
        kind: 'message.accepted',
        channelId: 'channel',
        memberId: 'member',
        contentHash: 'a'.repeat(64),
        at: 123
      })
    ])
    const durable = readFileSync(path, 'utf8')
    expect(durable).not.toContain('"content":')
    expect(durable).not.toContain('super-secret-value')
    expect(durable).not.toContain('/Users/alice')
    expect(JSON.parse(durable).events[0].detail.length).toBeLessThanOrEqual(160)
  })

  it('persists redacted agent mention and review-gate evidence without prompt text', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-agent-audit-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'audit.json')
    const log = new ChannelAuditLog(path)
    log.append({
      kind: 'agent.mention.rejected',
      channelId: 'channel',
      code: 'ambiguous_agent_mention',
      contentHash: 'a'.repeat(64),
      detail: 'candidate_count:2',
      at: 10
    })
    log.append({
      kind: 'agent.dispatch.blocked',
      channelId: 'channel',
      memberId: 'agent-build',
      code: 'channel_agent_review_required',
      contentHash: 'b'.repeat(64),
      detail: 'channels-p3-agent-participation-v1',
      at: 11
    })

    expect(new ChannelAuditLog(path).list()).toEqual([
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        memberId: 'agent-build',
        code: 'channel_agent_review_required',
        contentHash: 'b'.repeat(64)
      }),
      expect.objectContaining({
        kind: 'agent.mention.rejected',
        code: 'ambiguous_agent_mention',
        contentHash: 'a'.repeat(64)
      })
    ])
    const durable = readFileSync(path, 'utf8')
    expect(durable).not.toContain('prompt')
    expect(durable).not.toContain('message body')
    expect(durable).not.toContain('"content":')
  })

  it('deduplicates durable management evidence without projecting the signed object id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-management-audit-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'audit.json')
    const dedupeKey = 'c'.repeat(64)
    const signedObjectId = 'grant-sensitive-object-id'
    const append = (log: ChannelAuditLog) =>
      log.append({
        kind: 'agent.grant.issued',
        channelId: 'channel',
        memberId: 'agent-member',
        code: 'mention',
        detail: 'generation=2;budget=1',
        dedupeKey,
        at: 12
      })

    const first = new ChannelAuditLog(path)
    append(first)
    append(first)
    const restarted = new ChannelAuditLog(path)
    append(restarted)

    expect(restarted.list()).toEqual([
      expect.objectContaining({
        kind: 'agent.grant.issued',
        channelId: 'channel',
        memberId: 'agent-member',
        dedupeKey
      })
    ])
    const durable = readFileSync(path, 'utf8')
    expect(durable).not.toContain(signedObjectId)
    expect(() => restarted.append({ kind: 'agent.revoked', dedupeKey: signedObjectId })).toThrow(
      /dedupe key is invalid/
    )
    expect(restarted.list()).toHaveLength(1)
  })

  it('retains deduplicated agent dispatch and post evidence without provider output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-dispatch-audit-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'audit.json')
    const log = new ChannelAuditLog(path)
    const entries = [
      { kind: 'agent.dispatch.started' as const, code: 'codex', dedupeKey: '1'.repeat(64) },
      {
        kind: 'agent.dispatch.completed' as const,
        code: 'succeeded',
        dedupeKey: '2'.repeat(64)
      },
      {
        kind: 'agent.dispatch.failed' as const,
        code: 'launch_outcome_unknown',
        dedupeKey: '3'.repeat(64)
      },
      {
        kind: 'agent.post.committed' as const,
        code: 'appended',
        dedupeKey: '4'.repeat(64)
      }
    ]
    for (const entry of entries) {
      log.append({
        ...entry,
        channelId: 'channel',
        memberId: 'agent-member',
        contentHash: 'd'.repeat(64),
        detail: 'provider=codex;status=succeeded',
        at: 20
      })
      log.append({ ...entry, channelId: 'channel', memberId: 'agent-member', at: 21 })
    }

    const restarted = new ChannelAuditLog(path)
    expect(restarted.list().map((event) => event.kind)).toEqual([
      'agent.post.committed',
      'agent.dispatch.failed',
      'agent.dispatch.completed',
      'agent.dispatch.started'
    ])
    const durable = readFileSync(path, 'utf8')
    expect(durable).not.toContain('provider output')
    expect(durable).not.toContain('prompt')
    expect(durable).not.toContain('Exact terminal reply')
  })

  it('rolls back a failed durable append so the same dedupe key can be retried', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-audit-retry-'))
    temporaryDirectories.push(directory)
    const blockedParent = join(directory, 'blocked-parent')
    const path = join(blockedParent, 'audit.json')
    writeFileSync(blockedParent, 'not-a-directory')
    const log = new ChannelAuditLog(path)
    const input = {
      kind: 'agent.post.committed' as const,
      channelId: 'channel',
      memberId: 'agent-member',
      code: 'appended',
      dedupeKey: '4'.repeat(64),
      at: 22
    }

    expect(() => log.append(input)).toThrow()
    expect(log.list()).toEqual([])

    rmSync(blockedParent)
    mkdirSync(blockedParent)
    expect(() => log.append(input)).not.toThrow()
    expect(new ChannelAuditLog(path).list()).toEqual([
      expect.objectContaining({
        kind: 'agent.post.committed',
        dedupeKey: '4'.repeat(64)
      })
    ])
  })

  it('purges selected Channel evidence and reserves global purge for whole-history deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-audit-purge-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'audit.json')
    const log = new ChannelAuditLog(path)
    log.append({ kind: 'protocol.rejected', code: 'protocol_unsupported', at: 1 })
    log.append({ kind: 'channel.created', channelId: 'channel-a', at: 2 })
    log.append({ kind: 'channel.created', channelId: 'channel-b', at: 3 })
    const staleTemporary = `${path}.stale.tmp`
    writeFileSync(staleTemporary, 'stale audit evidence', 'utf8')

    expect(log.purgeChannels(['channel-a'])).toBe(1)
    expect(existsSync(staleTemporary)).toBe(false)
    expect(new ChannelAuditLog(path).list().map((event) => event.channelId ?? 'global')).toEqual([
      'channel-b',
      'global'
    ])
    expect(log.purgeChannels(['channel-a'])).toBe(0)
    expect(log.purgeAll()).toBe(2)
    expect(log.purgeAll()).toBe(0)
    expect(new ChannelAuditLog(path).list()).toEqual([])

    writeFileSync(path, 'corrupt audit evidence', 'utf8')
    const corrupt = new ChannelAuditLog(path)
    expect(corrupt.purgeAll()).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ events: [] })
  })
})
