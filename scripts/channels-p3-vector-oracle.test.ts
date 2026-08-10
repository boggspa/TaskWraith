import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

const fixturePath = new URL('./fixtures/channels-p3-canonical-vectors.json', import.meta.url)
const oraclePath = new URL('./channels-p3-vector-oracle.swift', import.meta.url)

interface OracleResult {
  schemaVersion: number
  language: string
  vectorCount: number
  vectors: Array<{ label: string; sha256: string; signatureVerified: boolean }>
  objectOrderIndependent: boolean
  arrayOrderPreserved: boolean
  invalidBase64Rejected: number
}

const runOnMac = process.platform === 'darwin' ? it : it.skip

describe('Channels P3 independent canonical-vector oracle', () => {
  runOnMac(
    'verifies canonical bytes, ordering, base64, and RFC-seeded Ed25519 signatures in Swift',
    () => {
      const result = spawnSync('swift', [oraclePath.pathname, fixturePath.pathname], {
        encoding: 'utf8',
        timeout: 120_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const evidence = JSON.parse(result.stdout) as OracleResult
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        language: 'swift',
        vectorCount: 4,
        objectOrderIndependent: true,
        arrayOrderPreserved: true,
        invalidBase64Rejected: 8
      })
      expect(evidence.vectors.map((vector) => vector.label)).toEqual([
        'delegation-unicode-maximums',
        'dispatch-grant-arrays-maximums',
        'agent-post-unicode-escapes',
        'revocation-maximums'
      ])
      expect(evidence.vectors.every((vector) => vector.signatureVerified)).toBe(true)
      expect(evidence.vectors.every((vector) => /^[a-f0-9]{64}$/.test(vector.sha256))).toBe(true)
    },
    130_000
  )

  it('is implementation-independent and carries no private signing material', () => {
    const source = readFileSync(oraclePath, 'utf8')
    const fixture = readFileSync(fixturePath, 'utf8')

    expect(source).toContain('import CryptoKit')
    expect(source).toContain('Curve25519.Signing.PublicKey')
    expect(source).not.toMatch(/ChannelAgentProtocol|typescript|node_modules/)
    expect(fixture).not.toMatch(/private|seed|9d61b19d|4ccd089b/i)
  })
})
