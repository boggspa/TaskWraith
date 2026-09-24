import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_ACP_EXTRACT_DIRNAME,
  ANTIGRAVITY_ACP_PIN_FILENAME,
  ANTIGRAVITY_ACP_VERSION,
  AntigravityAcpResolverError,
  antigravityAcpArchivePath,
  antigravityAcpExtractDir,
  antigravityAcpPinPath,
  buildAntigravityAcpLaunchArgs,
  createAntigravityAcpBinaryResolver,
  formatAntigravityAcpPinMismatchMessage,
  hashAntigravityAcpArchive,
  readAntigravityAcpPin,
  resolveAntigravityAcpBinary,
  resolveAntigravityAcpDistribution,
  type AntigravityAcpBinaryResolverDependencies
} from './AntigravityAcpBinaryResolver'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeInstallRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tw-agy-acp-'))
  cleanup.push(dir)
  return dir
}

function writeEntry(entryFileName: string) {
  return async (_bytes: Buffer, destDir: string): Promise<void> => {
    await mkdir(destDir, { recursive: true })
    await writeFile(join(destDir, entryFileName), 'fake-agy-acp-server\n')
  }
}

function deps(
  installRoot: string,
  overrides: Partial<AntigravityAcpBinaryResolverDependencies> & {
    archiveBytes?: Buffer
    entryFileName?: string
  } = {}
): AntigravityAcpBinaryResolverDependencies {
  const archiveBytes = overrides.archiveBytes ?? Buffer.from('first-install-archive')
  const entryFileName = overrides.entryFileName ?? 'agy_acp_server.par'
  const { archiveBytes: _ignored, entryFileName: _entry, ...rest } = overrides
  return {
    installRoot,
    platform: 'darwin',
    arch: 'arm64',
    now: () => new Date('2026-09-03T16:00:00.000Z'),
    downloadArchive: vi.fn(async () => archiveBytes),
    extractArchive: writeEntry(entryFileName),
    ...rest
  }
}

describe('resolveAntigravityAcpDistribution / launch args', () => {
  const matrix: Array<{
    platform: NodeJS.Platform
    arch: string
    id: string
    urlNeedle: string
    entry: string
    uid?: number
    args: string[]
  }> = [
    {
      platform: 'darwin',
      arch: 'arm64',
      id: 'darwin-aarch64',
      urlNeedle: 'darwin-arm64.zip',
      entry: 'agy_acp_server.par',
      args: []
    },
    {
      platform: 'linux',
      arch: 'x64',
      id: 'linux-x86_64',
      urlNeedle: 'linux-x86_64.zip',
      entry: 'agy_acp_server.par',
      uid: 501,
      args: ['--uid=501']
    },
    {
      platform: 'linux',
      arch: 'arm64',
      id: 'linux-aarch64',
      urlNeedle: 'linux-arm64.zip',
      entry: 'agy_acp_server.par',
      uid: 0,
      args: ['--uid=0']
    },
    {
      platform: 'win32',
      arch: 'x64',
      id: 'windows-x86_64',
      urlNeedle: 'windows-x86_64.zip',
      entry: 'agy_acp_server.exe',
      args: []
    },
    {
      platform: 'win32',
      arch: 'arm64',
      id: 'windows-aarch64',
      urlNeedle: 'windows-arm64.zip',
      entry: 'agy_acp_server.exe',
      args: []
    }
  ]

  it('maps each published platform to the registry archive URL, entry, and Linux --uid=', () => {
    for (const row of matrix) {
      const distribution = resolveAntigravityAcpDistribution(row.platform, row.arch)
      expect(distribution.platformId).toBe(row.id)
      expect(distribution.archiveUrl).toContain('dl.google.com/agy-extensions/releases/')
      expect(distribution.archiveUrl).toContain(row.urlNeedle)
      expect(distribution.entryFileName).toBe(row.entry)
      expect(buildAntigravityAcpLaunchArgs(distribution, row.uid)).toEqual(row.args)
    }
  })

  it('fails closed on darwin-x64 (no published archive)', () => {
    expect(() => resolveAntigravityAcpDistribution('darwin', 'x64')).toThrow(
      AntigravityAcpResolverError
    )
    try {
      resolveAntigravityAcpDistribution('darwin', 'x64')
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported-platform' })
    }
  })

  it('fails closed on Linux when no uid is available', () => {
    const distribution = resolveAntigravityAcpDistribution('linux', 'x64')
    expect(() => buildAntigravityAcpLaunchArgs(distribution, undefined)).toThrow(/--uid=/)
  })
})

describe('pin-on-first-install', () => {
  it('pins the observed archive hash beside the extract dir, not inside it', async () => {
    const root = await makeInstallRoot()
    const archiveBytes = Buffer.from('first-install-archive')
    const expectedHash = hashAntigravityAcpArchive(archiveBytes)
    const resolved = await resolveAntigravityAcpBinary(deps(root, { archiveBytes }))

    expect(resolved.pin.sha256).toBe(expectedHash)
    expect(resolved.pin.version).toBe(ANTIGRAVITY_ACP_VERSION)
    expect(resolved.pin.platform).toBe('darwin-aarch64')
    expect(resolved.pin.pinnedAt).toBe('2026-09-03T16:00:00.000Z')
    expect(resolved.pin.archiveUrl).toContain('darwin-arm64.zip')
    expect(resolved.binaryPath).toBe(join(antigravityAcpExtractDir(root), 'agy_acp_server.par'))
    expect(resolved.args).toEqual([])

    const pinPath = antigravityAcpPinPath(root)
    expect(pinPath).toBe(join(root, ANTIGRAVITY_ACP_PIN_FILENAME))
    expect(pinPath.includes(`${sep}${ANTIGRAVITY_ACP_EXTRACT_DIRNAME}${sep}`)).toBe(false)
    const onDisk = JSON.parse(await readFile(pinPath, 'utf8')) as { sha256: string }
    expect(onDisk.sha256).toBe(expectedHash)

    const factoryPin = await createAntigravityAcpBinaryResolver(
      deps(root, { archiveBytes })
    ).readPin()
    expect(factoryPin?.sha256).toBe(expectedHash)
  })

  it('reuses the pin and cached archive on a matching later launch without re-downloading', async () => {
    const root = await makeInstallRoot()
    const archiveBytes = Buffer.from('stable-archive-bytes')
    const downloadArchive = vi.fn(async () => archiveBytes)
    const first = await resolveAntigravityAcpBinary(deps(root, { archiveBytes, downloadArchive }))
    expect(downloadArchive).toHaveBeenCalledTimes(1)

    downloadArchive.mockImplementation(async () => {
      throw new Error('download must not run when the cached archive hashes to the pin')
    })
    const second = await resolveAntigravityAcpBinary(deps(root, { archiveBytes, downloadArchive }))
    expect(second.pin.sha256).toBe(first.pin.sha256)
    expect(second.binaryPath).toBe(first.binaryPath)
    expect(downloadArchive).toHaveBeenCalledTimes(1)
    expect(await readFile(antigravityAcpArchivePath(root))).toEqual(archiveBytes)
  })

  it('refuses a later launch whose archive hash does not match the pin and never re-pins', async () => {
    const root = await makeInstallRoot()
    const original = Buffer.from('pinned-archive')
    const other = Buffer.from('different-archive')
    await resolveAntigravityAcpBinary(deps(root, { archiveBytes: original }))
    const pinBefore = await readFile(antigravityAcpPinPath(root), 'utf8')
    const extract = vi.fn(writeEntry('agy_acp_server.par'))

    await writeFile(antigravityAcpArchivePath(root), other)

    await expect(
      resolveAntigravityAcpBinary(deps(root, { archiveBytes: other, extractArchive: extract }))
    ).rejects.toMatchObject({
      code: 'pin-mismatch',
      pinnedSha256: hashAntigravityAcpArchive(original),
      observedSha256: hashAntigravityAcpArchive(other)
    })

    const err = await resolveAntigravityAcpBinary(
      deps(root, { archiveBytes: other, extractArchive: extract })
    ).then(
      () => null,
      (error: unknown) => error as AntigravityAcpResolverError
    )
    expect(err?.message).toBe(
      formatAntigravityAcpPinMismatchMessage(
        hashAntigravityAcpArchive(original),
        hashAntigravityAcpArchive(other)
      )
    )
    expect(err?.message).toContain(hashAntigravityAcpArchive(original))
    expect(err?.message).toContain(hashAntigravityAcpArchive(other))
    expect(await readFile(antigravityAcpPinPath(root), 'utf8')).toBe(pinBefore)
    expect(extract).not.toHaveBeenCalled()
  })

  it('fails closed on a corrupt pin without writing a new one', async () => {
    const root = await makeInstallRoot()
    await writeFile(antigravityAcpPinPath(root), '{not-json')
    await expect(resolveAntigravityAcpBinary(deps(root))).rejects.toMatchObject({
      code: 'pin-corrupt'
    })
    await expect(readAntigravityAcpPin(deps(root))).rejects.toMatchObject({
      code: 'pin-corrupt'
    })
    expect(await readFile(antigravityAcpPinPath(root), 'utf8')).toBe('{not-json')
  })

  it('fails closed when artifacts exist but the pin sidecar is absent', async () => {
    const root = await makeInstallRoot()
    await mkdir(antigravityAcpExtractDir(root), { recursive: true })
    await writeFile(join(antigravityAcpExtractDir(root), 'agy_acp_server.par'), 'leftover')
    await expect(resolveAntigravityAcpBinary(deps(root))).rejects.toMatchObject({
      code: 'pin-absent'
    })
    await expect(readAntigravityAcpPin(deps(root))).resolves.toBeNull()
  })

  it('passes Linux --uid= through resolve when the uid is injected', async () => {
    const root = await makeInstallRoot()
    const resolved = await resolveAntigravityAcpBinary(
      deps(root, {
        platform: 'linux',
        arch: 'x64',
        getuid: () => 1000
      })
    )
    expect(resolved.args).toEqual(['--uid=1000'])
    expect(resolved.distribution.platformId).toBe('linux-x86_64')
  })
})

describe('source provenance', () => {
  it('does not ship a literal sha256 digest in the resolver or client source', async () => {
    const resolver = await readFile(join(__dirname, 'AntigravityAcpBinaryResolver.ts'), 'utf8')
    const client = await readFile(join(__dirname, 'AntigravityAcpClient.ts'), 'utf8')
    expect(resolver).not.toMatch(/[a-fA-F0-9]{64}/)
    expect(client).not.toMatch(/[a-fA-F0-9]{64}/)
  })
})
