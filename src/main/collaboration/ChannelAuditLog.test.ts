import { mkdtempSync, readFileSync, rmSync } from 'fs'
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
})
