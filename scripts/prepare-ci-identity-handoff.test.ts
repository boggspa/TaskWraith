import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { ARTIFACT_CONTRACT, baseManifest } = require('./identity-handoff-manifest.cjs')
const { prepareCiIdentityHandoff } = require('./prepare-ci-identity-handoff.cjs')
const roots: string[] = []
const sourceCommit = 'a'.repeat(40)
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function fixture(
  change: (manifest: any, assets: Map<string, Buffer>) => void = () => {},
  downloadTag = 'v0.1.0'
) {
  const root = mkdtempSync(join(tmpdir(), 'tw-ci-handoff-test-'))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  mkdirSync(repoRoot)
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ version: '1.9.9', taskwraithRelease: { distribution: 'beta' } })
  )
  const assets = new Map<string, Buffer>()
  const artifacts: Record<string, unknown> = {}
  for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT) as [string, any][]) {
    const bytes = Buffer.from(`final:${contract.fileName}`)
    assets.set(contract.fileName, bytes)
    artifacts[key] = {
      ...contract,
      url: `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${contract.fileName}`,
      size: bytes.length,
      sha256: digest(bytes)
    }
  }
  const manifest = baseManifest(true, artifacts, sourceCommit)
  change(manifest, assets)
  const payload = Buffer.from(JSON.stringify(manifest))
  assets.set('identity-handoff.json', payload)
  const run = vi.fn((command: string, args: string[]) => {
    if (command === 'git') {
      expect(args).toEqual(['rev-parse', 'HEAD'])
      return sourceCommit
    }
    expect(command).toBe('gh')
    expect(args.slice(0, 5)).toEqual([
      'release',
      'download',
      downloadTag,
      '--repo',
      'boggspa/TaskWraith'
    ])
    const name = args[6]
    expect(args[5]).toBe('--pattern')
    expect(args[7]).toBe('--dir')
    expect(assets.has(name)).toBe(true)
    writeFileSync(join(args[8], name), assets.get(name)!)
    return ''
  })
  return {
    options: { repoRoot, temporaryRoot: root, expectedPayloadSha256: digest(payload), downloadTag },
    run
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CI frozen handoff preparation', () => {
  it('verifies the approved payload and every target installer before returning build paths', async () => {
    const { options, run } = fixture()
    const prepared = await prepareCiIdentityHandoff(options, { execFileSync: run })
    expect(prepared.sourceCommit).toBe(sourceCommit)
    expect(prepared.payloadPath).toBe(join(prepared.artifactDir, 'identity-handoff.json'))
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('requires a locally supplied manifest digest before any download', async () => {
    const { options, run } = fixture()
    await expect(
      prepareCiIdentityHandoff({ ...options, expectedPayloadSha256: '' }, { execFileSync: run })
    ).rejects.toThrow('payload SHA-256 is required')
    expect(run).not.toHaveBeenCalled()
  })

  it('can verify identical final-URL bytes from a private candidate before publication', async () => {
    const { options, run } = fixture(undefined, 'v0.1.0-handoff-rc.1')
    await expect(prepareCiIdentityHandoff(options, { execFileSync: run })).resolves.toMatchObject({
      sourceCommit
    })
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('refuses arbitrary release names even with a supplied payload digest', async () => {
    const { options, run } = fixture()
    await expect(
      prepareCiIdentityHandoff({ ...options, downloadTag: '../other' }, { execFileSync: run })
    ).rejects.toThrow('handoff candidate')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects changed manifest bytes before downloading installers', async () => {
    const { options, run } = fixture()
    await expect(
      prepareCiIdentityHandoff(
        { ...options, expectedPayloadSha256: '0'.repeat(64) },
        { execFileSync: run }
      )
    ).rejects.toThrow('approved SHA-256')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rejects a payload from another source even when its digest was supplied', async () => {
    const { options, run } = fixture((manifest) => {
      manifest.sourceCommit = 'b'.repeat(40)
    })
    await expect(prepareCiIdentityHandoff(options, { execFileSync: run })).rejects.toThrow(
      'different source commit'
    )
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not follow an alternate download URL from the manifest', async () => {
    const { options, run } = fixture((manifest) => {
      manifest.artifacts['win32-x64'].url = 'https://example.test/installer.exe'
    })
    await expect(prepareCiIdentityHandoff(options, { execFileSync: run })).rejects.toThrow(
      'URL must be'
    )
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rejects changed installer bytes after downloading the complete inventory', async () => {
    const { options, run } = fixture((_manifest, assets) => {
      assets.set(ARTIFACT_CONTRACT['win32-x64'].fileName, Buffer.from('changed'))
    })
    await expect(prepareCiIdentityHandoff(options, { execFileSync: run })).rejects.toThrow(
      'sha256 mismatch'
    )
  })

  it('rejects a source that has not reached the final beta boundary', async () => {
    const { options, run } = fixture()
    writeFileSync(join(options.repoRoot, 'package.json'), JSON.stringify({ version: '1.9.8' }))
    await expect(prepareCiIdentityHandoff(options, { execFileSync: run })).rejects.toThrow(
      'frozen 1.9.9 beta source'
    )
    expect(run).toHaveBeenCalledTimes(1)
  })
})
