import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ARTIFACT_CONTRACT,
  HANDOFF_ID,
  baseManifest,
  parseArgs,
  prepareManifest,
  validateManifest,
  verifyArtifactDirectory
} = require('./identity-handoff-manifest.cjs') as {
  ARTIFACT_CONTRACT: Record<string, { fileName: string }>
  HANDOFF_ID: string
  baseManifest: (
    prepared: boolean,
    artifacts?: Record<string, unknown>,
    sourceCommit?: string | null
  ) => Record<string, any>
  parseArgs: (args: string[]) => { command: string; values: Record<string, string> }
  prepareManifest: (
    dir: string,
    baseUrl?: string,
    sourceCommit?: string
  ) => Promise<Record<string, any>>
  validateManifest: (
    manifest: unknown,
    options?: { requirePrepared?: boolean; expectedBaseUrl?: string }
  ) => string[]
  verifyArtifactDirectory: (manifest: unknown, dir: string) => Promise<string[]>
}

const roots: string[] = []
const SOURCE_COMMIT = 'a'.repeat(40)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function artifactDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'identity-handoff-manifest-'))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT)) {
    writeFileSync(
      join(root, contract.fileName),
      key.startsWith('win32-') ? signedPeFixture() : `artifact:${contract.fileName}`
    )
  }
  return root
}

function signedPeFixture(): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64, 'ascii')
  const optional = 64 + 24
  bytes.writeUInt16LE(0x020b, optional)
  bytes.writeUInt32LE(16, optional + 108)
  bytes.writeUInt32LE(400, optional + 112 + 4 * 8)
  bytes.writeUInt32LE(16, optional + 112 + 4 * 8 + 4)
  bytes.writeUInt32LE(16, 400)
  bytes.writeUInt16LE(0x0200, 404)
  bytes.writeUInt16LE(0x0002, 406)
  return bytes
}

describe('identity-handoff-manifest', () => {
  it('keeps an unprepared template valid before the final beta gate', () => {
    const template = baseManifest(false)
    expect(template.handoffId).toBe(HANDOFF_ID)
    expect(validateManifest(template)).toEqual([])
    expect(validateManifest(template, { requirePrepared: true })).toContain(
      'the 1.9.9 ship gate requires a prepared artifact inventory'
    )
  })

  it('builds a complete hash-pinned inventory from exact 0.1.0 artifacts', async () => {
    const dir = artifactDir()
    const manifest = await prepareManifest(dir, undefined, SOURCE_COMMIT)
    expect(validateManifest(manifest, { requirePrepared: true })).toEqual([])
    expect(Object.keys(manifest.artifacts)).toEqual(Object.keys(ARTIFACT_CONTRACT))
    for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT)) {
      expect(manifest.artifacts[key]).toMatchObject({
        fileName: contract.fileName,
        size: readFileSync(join(dir, contract.fileName)).length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        url: expect.stringContaining('/releases/download/v0.1.0/')
      })
    }
    await expect(verifyArtifactDirectory(manifest, dir)).resolves.toEqual([])
  })

  it('detects changed artifact bytes during rehearsal verification', async () => {
    const dir = artifactDir()
    const manifest = await prepareManifest(dir, undefined, SOURCE_COMMIT)
    const first = Object.values(ARTIFACT_CONTRACT)[0]!
    writeFileSync(join(dir, first.fileName), 'tampered')
    await expect(verifyArtifactDirectory(manifest, dir)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${first.fileName} (?:size|sha256) mismatch`))
      ])
    )
  })

  it('supports a hash-pinned throwaway rehearsal tag without weakening the final gate', async () => {
    const dir = artifactDir()
    const rehearsalBase =
      'https://github.com/boggspa/TaskWraith/releases/download/v0.1.0-handoff-rc.1'
    const manifest = await prepareManifest(dir, rehearsalBase, SOURCE_COMMIT)
    expect(
      validateManifest(manifest, {
        requirePrepared: true,
        expectedBaseUrl: rehearsalBase
      })
    ).toEqual([])
    expect(validateManifest(manifest, { requirePrepared: true })).toEqual(
      expect.arrayContaining([expect.stringContaining('URL must be')])
    )
  })

  it('rejects non-HTTPS and non-TaskWraith rehearsal bases', async () => {
    const dir = artifactDir()
    await expect(
      prepareManifest(
        dir,
        'http://github.com/boggspa/TaskWraith/releases/download/rehearsal',
        SOURCE_COMMIT
      )
    ).rejects.toThrow(/HTTPS TaskWraith GitHub release path/)
    await expect(
      prepareManifest(dir, 'https://example.test/releases/download/rehearsal', SOURCE_COMMIT)
    ).rejects.toThrow(/HTTPS TaskWraith GitHub release path/)
  })

  it('rejects unsigned Windows artifacts before they can enter a final manifest', async () => {
    const dir = artifactDir()
    writeFileSync(join(dir, ARTIFACT_CONTRACT['win32-x64'].fileName), 'unsigned PE bytes')
    await expect(prepareManifest(dir, undefined, SOURCE_COMMIT)).rejects.toThrow(
      /no Authenticode certificate/
    )
  })

  it('rejects identity drift and allowlisted artifact omissions', () => {
    const drifted = baseManifest(true, {}, SOURCE_COMMIT)
    drifted.target.appId = 'com.example.wrong'
    expect(validateManifest(drifted, { requirePrepared: true })).toEqual(
      expect.arrayContaining([
        'target identity/version/feed declaration drifted',
        'missing artifact darwin-universal',
        'missing artifact win32-x64',
        'missing artifact win32-arm64',
        'missing artifact linux-x64'
      ])
    )
  })

  it('parses prepare and default verify commands without positional ambiguity', () => {
    expect(parseArgs([])).toEqual({ command: 'verify', values: {} })
    expect(
      parseArgs(['prepare', '--artifact-dir', '/tmp/dist', '--output', '/tmp/out.json'])
    ).toEqual({
      command: 'prepare',
      values: { 'artifact-dir': '/tmp/dist', output: '/tmp/out.json' }
    })
  })
})
