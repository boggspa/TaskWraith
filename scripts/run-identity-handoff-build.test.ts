import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ARTIFACT_CONTRACT,
  prepareManifest
}: {
  ARTIFACT_CONTRACT: Record<string, { fileName: string }>
  prepareManifest: (
    artifactDir: string,
    baseUrl?: string,
    sourceCommit?: string
  ) => Promise<Record<string, unknown>>
} = require('./identity-handoff-manifest.cjs')
const {
  parseArgs,
  prepareHandoffBuild,
  runCli
}: {
  parseArgs: (argv: string[]) => {
    script: string
    payload: string
    artifactDir: string
    baseUrl: string
  }
  prepareHandoffBuild: (
    options: ReturnType<typeof parseArgs>,
    repoRoot: string,
    resolveCommit?: (root: string) => string
  ) => Promise<{
    script: string
    payloadPath: string
    artifactDir: string
    env: Record<string, string>
  }>
  runCli: (
    argv: string[],
    repoRoot: string,
    run: (command: string, args: string[], options: Record<string, unknown>) => unknown,
    resolveCommit?: (root: string) => string
  ) => Promise<number>
} = require('./run-identity-handoff-build.cjs')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(baseUrl?: string) {
  const root = mkdtempSync(join(tmpdir(), 'identity-handoff-build-'))
  roots.push(root)
  const artifactDir = join(root, 'artifacts')
  mkdirSync(artifactDir)
  for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT)) {
    writeFileSync(
      join(artifactDir, contract.fileName),
      key.startsWith('win32-') ? signedPeFixture() : contract.fileName
    )
  }
  const payload = join(root, 'payload.json')
  writeFileSync(
    payload,
    JSON.stringify(await prepareManifest(artifactDir, baseUrl, 'a'.repeat(40)))
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.9.9' }))
  writeFileSync(
    join(root, 'electron-builder.yml'),
    'appId: com.chrisizatt.taskwraith\ntaskwraithDistributionIdentity: beta\ntaskwraithUpdateFeedChannel: latest\n'
  )
  writeFileSync(
    join(root, 'electron-builder.debut.yml'),
    'appId: com.taskwraith.desktop\nversion: 0.1.0\ntaskwraithDistributionIdentity: release\ntaskwraithUpdateFeedChannel: release\ngenerateUpdatesFilesForAllChannels: false\nchannel: release\n'
  )
  return { root, artifactDir, payload }
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

describe('run-identity-handoff-build', () => {
  it('parses an explicit final-beta build contract', () => {
    expect(
      parseArgs([
        '--script',
        'build:mac:notarized',
        '--payload',
        '/tmp/payload.json',
        '--artifact-dir',
        '/tmp/artifacts'
      ])
    ).toMatchObject({
      script: 'build:mac:notarized',
      payload: '/tmp/payload.json',
      artifactDir: '/tmp/artifacts'
    })
  })

  it('verifies payload and exact target bytes before exposing the build environment', async () => {
    const { root, artifactDir, payload } = await fixture()
    await expect(
      prepareHandoffBuild(
        parseArgs([
          '--script',
          'build:mac:notarized',
          '--payload',
          payload,
          '--artifact-dir',
          artifactDir
        ]),
        root,
        () => 'a'.repeat(40)
      )
    ).resolves.toMatchObject({
      script: 'build:mac:notarized',
      payloadPath: payload,
      artifactDir,
      env: {
        TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD: payload,
        TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT: 'a'.repeat(40)
      }
    })
  })

  it('passes the verified payload into the selected existing release build', async () => {
    const { root, artifactDir, payload } = await fixture()
    const run = vi.fn(() => ({ status: 0 }))
    await expect(
      runCli(
        ['--script', 'build:linux:nopublish', '--payload', payload, '--artifact-dir', artifactDir],
        root,
        run,
        () => 'a'.repeat(40)
      )
    ).resolves.toBe(0)
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(?:\.cmd)?$/),
      ['run', 'build:linux:nopublish'],
      expect.objectContaining({
        env: expect.objectContaining({ TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD: payload })
      })
    )
  })

  it('rejects a target artifact changed after payload preparation', async () => {
    const { root, artifactDir, payload } = await fixture()
    const first = Object.values(ARTIFACT_CONTRACT)[0]!
    writeFileSync(join(artifactDir, first.fileName), 'changed')
    await expect(
      prepareHandoffBuild(
        parseArgs([
          '--script',
          'build:mac:notarized',
          '--payload',
          payload,
          '--artifact-dir',
          artifactDir
        ]),
        root,
        () => 'a'.repeat(40)
      )
    ).rejects.toThrow(/sha256 mismatch|size mismatch/)
  })

  it('rejects a wrapper invocation before the repository reaches exact 1.9.9', async () => {
    const { root, artifactDir, payload } = await fixture()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.9.8' }))
    await expect(
      prepareHandoffBuild(
        parseArgs([
          '--script',
          'build:mac:notarized',
          '--payload',
          payload,
          '--artifact-dir',
          artifactDir
        ]),
        root,
        () => 'a'.repeat(40)
      )
    ).rejects.toThrow(/must be exactly 1\.9\.9/)
  })

  it('rejects payload provenance from another source commit', async () => {
    const { root, artifactDir, payload } = await fixture()
    await expect(
      prepareHandoffBuild(
        parseArgs([
          '--script',
          'build:mac:notarized',
          '--payload',
          payload,
          '--artifact-dir',
          artifactDir
        ]),
        root,
        () => 'b'.repeat(40)
      )
    ).rejects.toThrow(/does not match current HEAD/)
  })
})
