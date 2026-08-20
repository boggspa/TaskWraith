import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDENTITY_HANDOFF_ID,
  IDENTITY_HANDOFF_SOURCE_VERSION,
  IDENTITY_HANDOFF_STATE_DIR,
  IDENTITY_HANDOFF_TARGET_VERSION,
  IdentityHandoffService,
  type IdentityHandoffArtifact,
  type IdentityHandoffFetchResponse,
  type IdentityHandoffManifest,
  validateIdentityHandoffManifest
} from './IdentityHandoffService'
import {
  BETA_DESKTOP_APP_ID,
  type AppDistributionIdentity,
  RELEASE_DESKTOP_APP_ID
} from './AppDistributionIdentity'

const roots: string[] = []
const BODY = Buffer.from('frozen public installer bytes')
const SHA256 = createHash('sha256').update(BODY).digest('hex')

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-identity-handoff-'))
  roots.push(root)
  return root
}

function distribution(series: 'beta' | 'release'): AppDistributionIdentity {
  return series === 'beta'
    ? {
        series: 'beta',
        appId: BETA_DESKTOP_APP_ID,
        stableUpdateChannel: 'latest',
        valid: true
      }
    : {
        series: 'release',
        appId: RELEASE_DESKTOP_APP_ID,
        stableUpdateChannel: 'release',
        valid: true
      }
}

function artifact(
  platform: IdentityHandoffArtifact['platform'],
  arch: IdentityHandoffArtifact['arch'],
  fileName: string,
  launchKind: IdentityHandoffArtifact['launchKind']
): IdentityHandoffArtifact {
  return {
    platform,
    arch,
    fileName,
    url: `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${fileName}`,
    size: BODY.length,
    sha256: SHA256,
    launchKind,
    instructions: 'Open the installer, replace the beta app, then launch TaskWraith Release.'
  }
}

function manifest(prepared = true): IdentityHandoffManifest {
  return {
    schemaVersion: 1,
    handoffId: IDENTITY_HANDOFF_ID,
    prepared,
    sourceCommit: prepared ? 'a'.repeat(40) : null,
    source: {
      distributionIdentity: 'beta',
      appId: BETA_DESKTOP_APP_ID,
      version: IDENTITY_HANDOFF_SOURCE_VERSION,
      updateFeedChannel: 'latest'
    },
    target: {
      distributionIdentity: 'release',
      appId: RELEASE_DESKTOP_APP_ID,
      version: IDENTITY_HANDOFF_TARGET_VERSION,
      updateFeedChannel: 'release'
    },
    supportUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
    artifacts: prepared
      ? {
          'darwin-universal': artifact(
            'darwin',
            'universal',
            'TaskWraith-0.1.0-universal-mac.dmg',
            'dmg'
          ),
          'win32-x64': artifact('win32', 'x64', 'TaskWraith-0.1.0-win-x64-setup.exe', 'nsis'),
          'win32-arm64': artifact('win32', 'arm64', 'TaskWraith-0.1.0-win-arm64-setup.exe', 'nsis'),
          'linux-x64': artifact('linux', 'x64', 'TaskWraith-0.1.0.AppImage', 'appimage')
        }
      : {}
  }
}

function response(
  chunks: Array<Uint8Array | Error>,
  options: { status?: number; contentRange?: string } = {}
): IdentityHandoffFetchResponse {
  let index = 0
  const status = options.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://objects.githubusercontent.com/release-installer',
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-range' ? options.contentRange || null : null
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            const next = chunks[index++]
            if (next instanceof Error) throw next
            return next ? { done: false, value: next } : { done: true }
          }
        }
      }
    }
  }
}

function service(
  root: string,
  overrides: Partial<ConstructorParameters<typeof IdentityHandoffService>[0]> = {}
): IdentityHandoffService {
  return new IdentityHandoffService({
    manifest: manifest(),
    currentVersion: IDENTITY_HANDOFF_SOURCE_VERSION,
    currentDistribution: distribution('beta'),
    userDataPath: root,
    platform: 'darwin',
    arch: 'arm64',
    fetcher: vi.fn(async () => response([BODY])),
    launchInstaller: vi.fn(() => ({ ok: true })),
    ...overrides
  })
}

describe('IdentityHandoffService', () => {
  it('accepts the unprepared pre-1.9.9 manifest template', () => {
    expect(validateIdentityHandoffManifest(manifest(false))).toMatchObject({ ok: true })
  })

  it('accepts a same-repository throwaway rehearsal tag because bytes remain hash-pinned', () => {
    const rehearsal = manifest()
    for (const artifact of Object.values(rehearsal.artifacts)) {
      if (artifact) artifact.url = artifact.url.replace('/v0.1.0/', '/v0.1.0-handoff-rc.1/')
    }
    expect(validateIdentityHandoffManifest(rehearsal)).toMatchObject({ ok: true })
  })

  it('rejects a prepared runtime payload whose platform filename drifted', () => {
    const drifted = manifest()
    const mac = drifted.artifacts['darwin-universal']!
    mac.fileName = 'TaskWraith-0.1.0-other-mac.dmg'
    mac.url = `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${mac.fileName}`
    expect(validateIdentityHandoffManifest(drifted)).toMatchObject({ ok: false })
  })

  it('exposes a prepared handoff only to the exact 1.9.9 beta identity', () => {
    const root = tempRoot()
    expect(service(root).snapshot()).toMatchObject({
      active: true,
      phase: 'ready',
      sourceVersion: '1.9.9',
      targetVersion: '0.1.0',
      targetAppId: RELEASE_DESKTOP_APP_ID,
      artifactFileName: 'TaskWraith-0.1.0-universal-mac.dmg'
    })

    expect(service(tempRoot(), { currentVersion: '1.9.8' }).snapshot()).toMatchObject({
      active: false,
      phase: 'inactive'
    })
  })

  it('downloads, hashes, records, launches, and quits the exact installer', async () => {
    vi.useFakeTimers()
    const root = tempRoot()
    const launchInstaller = vi.fn(() => ({ ok: true as const }))
    const quit = vi.fn()
    const handoff = service(root, { launchInstaller, quit })

    await expect(handoff.download()).resolves.toMatchObject({
      phase: 'downloaded',
      downloadedBytes: BODY.length,
      percent: 100
    })
    expect(handoff.launch()).toBe(true)
    expect(handoff.snapshot()).toMatchObject({ phase: 'awaiting-target' })
    expect(launchInstaller).toHaveBeenCalledWith(
      expect.stringContaining('TaskWraith-0.1.0-universal-mac.dmg'),
      expect.objectContaining({ sha256: SHA256 })
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(quit).toHaveBeenCalledTimes(1)

    const persisted = JSON.parse(
      readFileSync(join(root, IDENTITY_HANDOFF_STATE_DIR, 'state.json'), 'utf8')
    )
    expect(persisted).toMatchObject({
      handoffId: IDENTITY_HANDOFF_ID,
      phase: 'awaiting-target',
      attempts: 1,
      downloadedBytes: BODY.length,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactSha256: SHA256
    })
  })

  it('keeps partial bytes and resumes an interrupted download after relaunch', async () => {
    const root = tempRoot()
    const midpoint = 9
    const first = service(root, {
      fetcher: vi.fn(async () => response([BODY.subarray(0, midpoint), new Error('offline')]))
    })
    await expect(first.download()).resolves.toMatchObject({
      phase: 'error',
      resumeAvailable: true,
      downloadedBytes: midpoint
    })

    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.headers).toEqual({ Range: `bytes=${midpoint}-` })
      return response([BODY.subarray(midpoint)], {
        status: 206,
        contentRange: `bytes ${midpoint}-${BODY.length - 1}/${BODY.length}`
      })
    })
    const resumed = service(root, { fetcher })
    expect(resumed.snapshot()).toMatchObject({ phase: 'error', resumeAvailable: true })
    await expect(resumed.retry()).resolves.toMatchObject({
      phase: 'downloaded',
      attempts: 2,
      percent: 100
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('re-verifies an existing installer after a source relaunch', async () => {
    const root = tempRoot()
    const first = service(root)
    await first.download()

    const fetcher = vi.fn(async () => response([BODY]))
    const relaunched = service(root, { fetcher })
    expect(relaunched.snapshot().phase).toBe('ready')
    await expect(relaunched.download()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('marks the durable receipt complete when the Release identity launches', async () => {
    const root = tempRoot()
    const source = service(root)
    await source.download()
    expect(source.launch()).toBe(true)

    const target = service(root, {
      currentVersion: IDENTITY_HANDOFF_TARGET_VERSION,
      currentDistribution: distribution('release')
    })
    expect(target.snapshot()).toMatchObject({
      active: false,
      phase: 'complete',
      completedAt: expect.any(String)
    })
    expect(
      existsSync(join(root, IDENTITY_HANDOFF_STATE_DIR, 'TaskWraith-0.1.0-universal-mac.dmg'))
    ).toBe(false)
  })

  it('does not complete a target receipt without installer-launch evidence', async () => {
    const root = tempRoot()
    const source = service(root, {
      fetcher: vi.fn(async () => response([BODY.subarray(0, 4), new Error('offline')]))
    })
    await source.download()
    const target = service(root, {
      currentVersion: IDENTITY_HANDOFF_TARGET_VERSION,
      currentDistribution: distribution('release')
    })
    expect(target.snapshot()).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'target-transition-unproven'
    })
  })

  it('rejects a non-string launchedAt instead of treating truthiness as launch evidence', async () => {
    const root = tempRoot()
    const source = service(root)
    await source.download()
    expect(source.launch()).toBe(true)
    const statePath = join(root, IDENTITY_HANDOFF_STATE_DIR, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.launchedAt = 1
    writeFileSync(statePath, JSON.stringify(state))

    expect(
      service(root, {
        currentVersion: IDENTITY_HANDOFF_TARGET_VERSION,
        currentDistribution: distribution('release')
      }).snapshot()
    ).toMatchObject({
      phase: 'blocked',
      errorCode: 'state-unreadable'
    })
  })

  it('blocks a prepared payload without an artifact for the running platform', () => {
    expect(service(tempRoot(), { platform: 'linux', arch: 'arm64' }).snapshot()).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'unsupported-platform'
    })
  })

  it('rejects an unprepared payload on the exact handoff build', () => {
    expect(service(tempRoot(), { manifest: manifest(false) }).snapshot()).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'payload-not-prepared'
    })
  })

  it('fails closed when a packaged 1.9.9 build carries mixed identity metadata', () => {
    expect(
      service(tempRoot(), {
        currentDistribution: {
          series: 'invalid',
          stableUpdateChannel: 'latest',
          valid: false,
          reason: 'mixed package identity'
        }
      }).snapshot()
    ).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'invalid-source-identity',
      errorMessage: 'mixed package identity'
    })
  })

  it('does not launch bytes that fail their pinned hash', async () => {
    const root = tempRoot()
    const handoff = service(root, {
      fetcher: vi.fn(async () => response([Buffer.from('wrong bytes of same length!!')]))
    })
    const snapshot = await handoff.download()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.errorMessage).toMatch(/incomplete|integrity/i)
    expect(handoff.launch()).toBe(false)
  })

  it('refuses a symlinked partial download without touching its target', async () => {
    const root = tempRoot()
    const stateDir = join(root, IDENTITY_HANDOFF_STATE_DIR)
    mkdirSync(stateDir, { recursive: true })
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const handoff = service(root)
    const partial = join(stateDir, 'TaskWraith-0.1.0-universal-mac.dmg.partial')
    symlinkSync(outside, partial)

    await expect(handoff.download()).resolves.toMatchObject({
      phase: 'error',
      errorMessage: expect.stringMatching(/regular file/i)
    })
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
  })

  it('fails closed on a corrupt durable receipt in either distributed identity', () => {
    const root = tempRoot()
    const stateDir = join(root, IDENTITY_HANDOFF_STATE_DIR)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), '{not-json')

    expect(service(root).snapshot()).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'state-unreadable'
    })
    expect(
      service(root, {
        currentVersion: IDENTITY_HANDOFF_TARGET_VERSION,
        currentDistribution: distribution('release')
      }).snapshot()
    ).toMatchObject({
      active: true,
      phase: 'blocked',
      errorCode: 'state-unreadable'
    })
  })

  it('coalesces duplicate download requests into one network operation', async () => {
    const root = tempRoot()
    let resolveFetch!: (value: IdentityHandoffFetchResponse) => void
    const fetcher = vi.fn(
      () =>
        new Promise<IdentityHandoffFetchResponse>((resolve) => {
          resolveFetch = resolve
        })
    )
    const handoff = service(root, { fetcher })
    const first = handoff.download()
    const second = handoff.download()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    resolveFetch(response([BODY]))
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ phase: 'downloaded' }),
      expect.objectContaining({ phase: 'downloaded' })
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
