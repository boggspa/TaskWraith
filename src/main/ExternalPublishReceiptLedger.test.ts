import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ExternalPublishReceiptLedger,
  MAX_EXTERNAL_PUBLISH_RECEIPTS
} from './ExternalPublishReceiptLedger'

describe('ExternalPublishReceiptLedger', () => {
  let tmpDir: string
  let storagePath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'external-publish-receipts-'))
    storagePath = join(tmpDir, 'external-publish-receipts.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a pre-side-effect decision and completion metadata', () => {
    const ledger = new ExternalPublishReceiptLedger({
      storagePath,
      now: () => '2026-07-03T00:00:00.000Z',
      idFactory: () => 'receipt-1'
    })

    const receipt = ledger.begin({
      origin: 'desktop-ui',
      action: 'gitPush',
      decision: 'allowed',
      reason: 'Desktop user initiated external publishing.',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      repoPath: '/repo',
      remote: 'origin',
      setUpstream: true
    })

    expect(receipt).toMatchObject({
      id: 'receipt-1',
      origin: 'desktop-ui',
      action: 'gitPush',
      decision: 'allowed',
      workspacePath: '/repo',
      remote: 'origin',
      setUpstream: true
    })

    const completed = ledger.complete({
      id: 'receipt-1',
      outcome: 'completed',
      commitSha: 'abc123'
    })

    expect(completed).toMatchObject({
      id: 'receipt-1',
      outcome: 'completed',
      commitSha: 'abc123',
      completedAt: '2026-07-03T00:00:00.000Z'
    })
    expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual([completed])
  })

  it('redacts string metadata and loads only valid records', () => {
    writeFileSync(
      storagePath,
      JSON.stringify([
        {
          schemaVersion: 1,
          id: 'good',
          origin: 'ios-bridge',
          action: 'githubCreatePr',
          decision: 'allowed',
          reason: 'accepted',
          requestedAt: '2026-07-03T00:00:00.000Z'
        },
        { id: 'bad' }
      ]),
      'utf-8'
    )
    const ledger = new ExternalPublishReceiptLedger({ storagePath })

    ledger.begin({
      id: 'with-secret',
      origin: 'desktop-ui',
      action: 'githubCreatePr',
      decision: 'denied',
      reason: 'Blocked token sk-1234567890abcdefghijklmnop',
      requestedAt: '2026-07-03T00:00:01.000Z',
      metadata: { token: 'sk-1234567890abcdefghijklmnop', count: 2 }
    })

    expect(ledger.list()).toHaveLength(2)
    expect(ledger.list()[1].reason).not.toContain('sk-1234567890')
    expect(ledger.list()[1].metadata?.token).not.toContain('sk-1234567890')
    expect(ledger.list()[1].metadata?.count).toBe(2)
  })

  it('caps the ledger to the newest records', () => {
    const ledger = new ExternalPublishReceiptLedger({
      now: () => '2026-07-03T00:00:00.000Z'
    })

    for (let index = 0; index < MAX_EXTERNAL_PUBLISH_RECEIPTS + 1; index += 1) {
      ledger.begin({
        id: `receipt-${index}`,
        origin: 'agent',
        action: 'gitPush',
        decision: 'allowed',
        reason: 'approved',
        requestedAt: '2026-07-03T00:00:00.000Z'
      })
    }

    const rows = ledger.list()
    expect(rows).toHaveLength(MAX_EXTERNAL_PUBLISH_RECEIPTS)
    expect(rows[0].id).toBe('receipt-1')
    expect(rows[rows.length - 1].id).toBe(`receipt-${MAX_EXTERNAL_PUBLISH_RECEIPTS}`)
  })

  it('purges old receipts by age while supporting dry-run', () => {
    const ledger = new ExternalPublishReceiptLedger({ storagePath })
    ledger.begin({
      id: 'old',
      origin: 'agent',
      action: 'gitPush',
      decision: 'allowed',
      reason: 'old',
      requestedAt: '2026-06-01T00:00:00.000Z'
    })
    ledger.begin({
      id: 'fresh',
      origin: 'agent',
      action: 'gitPush',
      decision: 'allowed',
      reason: 'fresh',
      requestedAt: '2026-07-02T00:00:00.000Z'
    })

    const cutoff = Date.parse('2026-07-01T00:00:00.000Z')
    expect(ledger.purgeOlderThan(cutoff, { dryRun: true })).toEqual({
      scanned: 2,
      retained: 1,
      deleted: 1
    })
    expect(ledger.list().map((receipt) => receipt.id)).toEqual(['old', 'fresh'])

    expect(ledger.purgeOlderThan(cutoff)).toEqual({
      scanned: 2,
      retained: 1,
      deleted: 1
    })
    expect(ledger.list().map((receipt) => receipt.id)).toEqual(['fresh'])
  })
})
