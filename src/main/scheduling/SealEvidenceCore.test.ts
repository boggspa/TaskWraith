import { createHmac } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import {
  SealEvidenceError,
  SealEvidenceFileHasher,
  canonicalEvidenceEncode,
  interpreterRuntimeAttestationSha256,
  launchArgsTemplateSha256,
  nearestPackageManifestPath,
  providerLaunchHmacOfCanonicalJson,
  redactConfigurationSecrets,
  sha256HexOfCanonicalJson,
  sha256HexOfUtf8
} from './SealEvidenceCore'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'seal-evidence-core-'))

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function testRoot(marker = '7'): ScheduledOccurrenceAuthorityRoot {
  const key = Buffer.alloc(32, 41)
  const mac = (domain: string, payload: Buffer): string =>
    createHmac('sha256', key).update(domain).update(payload).digest('hex')
  return Object.freeze({
    rootId: `twso-root-v1:${marker.repeat(64)}`,
    sealPayloadMac: (payload: Buffer) => mac('seal', payload),
    verifySealPayloadMac: (payload: Buffer, value: string) => mac('seal', payload) === value,
    walPayloadMac: (payload: Buffer) => mac('wal', payload),
    verifyWalPayloadMac: (payload: Buffer, value: string) => mac('wal', payload) === value,
    runtimeProfileSetHmac: (payload: Buffer) => mac('runtime', payload),
    permissionPostureSetHmac: (payload: Buffer) => mac('posture', payload),
    providerLaunchHmac: (provider: string, payload: Buffer) =>
      mac(`provider:${provider}`, payload),
    verifyProviderLaunchHmac: (provider: string, payload: Buffer, value: string) =>
      mac(`provider:${provider}`, payload) === value,
    dispose: () => {}
  }) as ScheduledOccurrenceAuthorityRoot
}

describe('canonical evidence encoding', () => {
  it('sorts keys, drops undefined members, and stays injective over key order', () => {
    expect(canonicalEvidenceEncode({ b: 1, a: 'x', dropped: undefined })).toBe(
      '{"a":"x","b":1}'
    )
    expect(canonicalEvidenceEncode({ a: 'x', b: 1 })).toBe(
      canonicalEvidenceEncode({ b: 1, a: 'x' })
    )
    expect(canonicalEvidenceEncode([1, 'two', null, { z: true, y: false }])).toBe(
      '[1,"two",null,{"y":false,"z":true}]'
    )
  })

  it('rejects non-finite numbers, cycles, exotic prototypes and undefined array holes', () => {
    expect(() => canonicalEvidenceEncode({ value: Number.POSITIVE_INFINITY })).toThrow(
      SealEvidenceError
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalEvidenceEncode(cyclic)).toThrow(/cyclic/i)
    expect(() => canonicalEvidenceEncode(new Map() as unknown)).toThrow(SealEvidenceError)
    expect(() => canonicalEvidenceEncode([undefined] as unknown[])).toThrow(/undefined/i)
    expect(() => canonicalEvidenceEncode({ [Symbol('x')]: 1, a: 1 } as unknown)).toThrow(
      /symbol/i
    )
  })

  it('binds digests and keyed HMACs to the canonical bytes', () => {
    const digest = sha256HexOfCanonicalJson({ a: 1, b: 2 })
    expect(digest).toBe(sha256HexOfUtf8('{"a":1,"b":2}'))
    const root = testRoot()
    const hmac = providerLaunchHmacOfCanonicalJson(root, 'codex', { b: 2, a: 1 })
    expect(hmac).toBe(providerLaunchHmacOfCanonicalJson(root, 'codex', { a: 1, b: 2 }))
    expect(hmac).not.toBe(providerLaunchHmacOfCanonicalJson(root, 'claude', { a: 1, b: 2 }))
  })
})

describe('SealEvidenceFileHasher', () => {
  it('hashes through symlinks to the canonical real path and caches on (size, mtime)', async () => {
    const hasher = new SealEvidenceFileHasher()
    const target = join(TEMP_ROOT, 'binary-one')
    writeFileSync(target, 'binary payload one')
    const link = join(TEMP_ROOT, 'binary-link')
    symlinkSync(target, link)

    const direct = await hasher.digestFile(target)
    const viaLink = await hasher.digestFile(link)
    expect(viaLink.realPath).toBe(direct.realPath)
    expect(viaLink.sha256).toBe(direct.sha256)
    expect(direct.sha256).toMatch(/^[0-9a-f]{64}$/)

    const again = await hasher.digestFile(target)
    expect(again.sha256).toBe(direct.sha256)
  })

  it('re-hashes when the file content changes', async () => {
    const hasher = new SealEvidenceFileHasher()
    const target = join(TEMP_ROOT, 'binary-two')
    writeFileSync(target, 'first content')
    const first = await hasher.digestFile(target)
    writeFileSync(target, 'second content longer')
    const second = await hasher.digestFile(target)
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('does not trust a stale cache row when mtime changes with equal size', async () => {
    const hasher = new SealEvidenceFileHasher()
    const target = join(TEMP_ROOT, 'binary-three')
    writeFileSync(target, 'aaaa')
    const first = await hasher.digestFile(target)
    writeFileSync(target, 'bbbb')
    utimesSync(target, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    const second = await hasher.digestFile(target)
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('rejects missing files and directories', async () => {
    const hasher = new SealEvidenceFileHasher()
    await expect(hasher.digestFile(join(TEMP_ROOT, 'missing'))).rejects.toThrow(
      SealEvidenceError
    )
    await expect(hasher.digestFile(TEMP_ROOT)).rejects.toThrow(/regular file/i)
  })
})

describe('launch argv template digest', () => {
  it('binds argv order and content', () => {
    const one = launchArgsTemplateSha256(['exec', '--flag', '{taskwraith:prompt}'])
    const two = launchArgsTemplateSha256(['exec', '{taskwraith:prompt}', '--flag'])
    expect(one).not.toBe(two)
    expect(one).toBe(launchArgsTemplateSha256(['exec', '--flag', '{taskwraith:prompt}']))
  })

  it('rejects non-string argv entries', () => {
    expect(() => launchArgsTemplateSha256([1 as unknown as string])).toThrow(SealEvidenceError)
  })
})

describe('interpreter runtime attestation', () => {
  it('attests native binaries without a shebang', async () => {
    const hasher = new SealEvidenceFileHasher()
    const native = join(TEMP_ROOT, 'native-binary')
    writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01]))
    const result = await interpreterRuntimeAttestationSha256(native, undefined, hasher)
    expect(result.attestation).toEqual({ schemaVersion: 1, kind: 'native-executable' })
    expect(result.sha256).toBe(sha256HexOfCanonicalJson(result.attestation))
  })

  it('attests direct-shebang scripts with the interpreter digest', async () => {
    const hasher = new SealEvidenceFileHasher()
    const interpreter = join(TEMP_ROOT, 'interp')
    writeFileSync(interpreter, 'interpreter-bytes')
    const script = join(TEMP_ROOT, 'script-direct')
    writeFileSync(script, `#!${interpreter}\nconsole.log(1)\n`)
    const result = await interpreterRuntimeAttestationSha256(script, undefined, hasher)
    const attestation = result.attestation as Record<string, unknown>
    expect(attestation.kind).toBe('shebang-script')
    expect(attestation.interpreterSha256).toBe((await hasher.digestFile(interpreter)).sha256)
    expect(attestation.envResolvedName).toBeNull()
  })

  it('resolves env shebangs against the provided spawn PATH', async () => {
    const hasher = new SealEvidenceFileHasher()
    const binDir = join(TEMP_ROOT, 'env-bin')
    writeFileSync(join(TEMP_ROOT, 'placeholder'), '')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    const node = join(binDir, 'fakenode')
    writeFileSync(node, 'fake node interpreter bytes')
    chmodSync(node, 0o755)
    const script = join(TEMP_ROOT, 'script-env')
    writeFileSync(script, '#!/usr/bin/env fakenode\nmain()\n')
    const result = await interpreterRuntimeAttestationSha256(script, binDir, hasher)
    const attestation = result.attestation as Record<string, unknown>
    expect(attestation.kind).toBe('shebang-script')
    expect(attestation.envResolvedName).toBe('fakenode')
    expect(attestation.interpreterRealPath).toBe((await hasher.digestFile(node)).realPath)
  })

  it('fails closed when the env shebang target is not on the spawn PATH', async () => {
    const hasher = new SealEvidenceFileHasher()
    const script = join(TEMP_ROOT, 'script-env-missing')
    writeFileSync(script, '#!/usr/bin/env definitely-not-a-real-interpreter\n')
    await expect(
      interpreterRuntimeAttestationSha256(script, join(TEMP_ROOT, 'env-bin'), hasher)
    ).rejects.toThrow(/not resolvable/i)
  })
})

describe('nearestPackageManifestPath', () => {
  it('finds the closest package.json walking upward', async () => {
    const { mkdirSync } = await import('node:fs')
    const pkgRoot = join(TEMP_ROOT, 'pkg')
    const nested = join(pkgRoot, 'dist', 'bin')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), '{"name":"pkg"}')
    const entry = join(nested, 'cli.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    expect(await nearestPackageManifestPath(entry)).toBe(join(pkgRoot, 'package.json'))
  })
})

describe('redactConfigurationSecrets', () => {
  it('replaces secret-shaped values with keyed HMAC references, recursively', () => {
    const root = testRoot()
    const redacted = redactConfigurationSecrets(
      {
        model: 'gpt-x',
        api_key: 'raw-secret-bytes',
        auth: { refresh_token: 'rotating', harmless: 'kept' },
        nested: [{ Authorization: 'Bearer abc' }]
      },
      root,
      'codex'
    ) as Record<string, unknown>
    expect(redacted.model).toBe('gpt-x')
    expect(JSON.stringify(redacted)).not.toContain('raw-secret-bytes')
    expect(JSON.stringify(redacted)).not.toContain('rotating')
    expect(JSON.stringify(redacted)).not.toContain('Bearer abc')
    const apiKey = redacted.api_key as Record<string, string>
    expect(apiKey.__taskwraithRedactedSecretHmac).toMatch(/^[0-9a-f]{64}$/)
    // Everything nested under a secret-shaped key is redacted, including
    // non-secret-named children.
    const auth = redacted.auth as Record<string, unknown>
    expect(JSON.stringify(auth.harmless)).not.toContain('kept')
  })

  it('keeps redaction change-sensitive: a rotated secret changes the digest', () => {
    const root = testRoot()
    const before = sha256HexOfCanonicalJson(
      redactConfigurationSecrets({ api_key: 'one' }, root, 'grok')
    )
    const after = sha256HexOfCanonicalJson(
      redactConfigurationSecrets({ api_key: 'two' }, root, 'grok')
    )
    expect(before).not.toBe(after)
  })
})
