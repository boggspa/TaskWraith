import { describe, expect, it } from 'vitest'
import { buildP7DirectSend, selectP7TokenEntry } from './push-p7-direct-send'

const entry = {
  pairID: 'iphone-1234567890abcdef',
  macIdentityPubKey: 'mac-key',
  deviceTokenHex: 'aabbccdd',
  env: 'sandbox' as const,
  notifyFinishedTurns: true
}

describe('push P7 direct-send harness', () => {
  it('selects one exact relay token without exposing it in the receipt layer', () => {
    expect(selectP7TokenEntry({ entries: [entry] })).toEqual(entry)
    expect(
      selectP7TokenEntry({ entries: [entry] }, { pairId: entry.pairID, env: 'sandbox' })
    ).toEqual(entry)
    expect(() => selectP7TokenEntry({ entries: [] })).toThrow(/exactly one/)
    expect(() =>
      selectP7TokenEntry({ entries: [entry, { ...entry, pairID: 'iphone-other' }] })
    ).toThrow(/exactly one/)
  })

  it('uses the same collapse id and routing-only banner as Tier-2', () => {
    const send = buildP7DirectSend({
      entry,
      reason: 'runComplete',
      threadId: 'thread-1',
      runId: 'run-1'
    })
    expect(send.collapseId).toMatch(/^tw1-[0-9a-f]{56}$/)
    expect(send.body).toEqual({
      aps: {
        alert: { title: 'TaskWraith', body: 'A task finished.' },
        sound: 'default'
      }
    })
    expect(JSON.stringify(send.body)).not.toContain('thread-1')
    expect(JSON.stringify(send.body)).not.toContain('run-1')
  })
})
