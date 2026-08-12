import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { TRANSCRIPT_MEDIA_ASSET_DIR } from '../services/TranscriptMediaAssetStore'
import type { StudioCompanionChild } from './StudioCompanionSupervisor'
import {
  STUDIO_COMPANION_EXECUTABLE,
  resolveStudioCompanionBinaryPath,
  startStudioProductionLifecycle
} from './StudioProductionLifecycle'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tw-studio-production-'))
  temporaryRoots.push(root)
  return root
}

class FakeStudioChild extends EventEmitter implements StudioCompanionChild {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  constructor() {
    super()
    this.stdin.on('finish', () => this.emit('exit', 0, null))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.emit('exit', null, signal)
    return true
  }
}

describe('StudioProductionLifecycle', () => {
  it('prefers the packaged nested app and falls back to the dev build', () => {
    const resourcesPath = nodePath.join('/Applications', 'TaskWraith.app', 'Contents', 'Resources')
    const bundled = nodePath.join(
      resourcesPath,
      'studio',
      'TaskWraith Studio.app',
      'Contents',
      'MacOS',
      STUDIO_COMPANION_EXECUTABLE
    )
    expect(
      resolveStudioCompanionBinaryPath({
        resourcesPath,
        developmentRoot: '/repo',
        pathExists: (path) => path === bundled
      })
    ).toBe(bundled)
    expect(
      resolveStudioCompanionBinaryPath({
        developmentRoot: '/repo',
        pathExists: (path) => path.includes('/debug/')
      })
    ).toBe(
      nodePath.join(
        '/repo',
        'swift',
        'TaskWraithBridge',
        '.build',
        'debug',
        STUDIO_COMPANION_EXECUTABLE
      )
    )
  })

  it('is side-effect free when disabled', async () => {
    const root = await temporaryRoot()
    let spawned = false
    const result = await startStudioProductionLifecycle({
      userDataPath: root,
      binaryPath: '/does/not/matter',
      settingEnabled: false,
      platform: 'darwin',
      pathExists: () => true,
      spawnProcess: () => {
        spawned = true
        return new FakeStudioChild()
      }
    })
    expect(result.lifecycle).toBeNull()
    expect(spawned).toBe(false)
    await expect(
      fsPromises.stat(nodePath.join(root, TRANSCRIPT_MEDIA_ASSET_DIR))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails clearly instead of spawning an unresolved binary', async () => {
    const root = await temporaryRoot()
    await expect(
      startStudioProductionLifecycle({
        userDataPath: root,
        binaryPath: '/missing/TaskWraithStudioCompanion',
        platform: 'darwin',
        pathExists: () => false
      })
    ).rejects.toMatchObject({
      code: 'binary_missing',
      path: '/missing/TaskWraithStudioCompanion'
    })
  })

  it('launches the viewer with the transcript-media jail and disposes on EOF', async () => {
    const root = await temporaryRoot()
    const child = new FakeStudioChild()
    const launches: { command: string; args: readonly string[] }[] = []
    const result = await startStudioProductionLifecycle({
      userDataPath: root,
      binaryPath: '/fake/TaskWraithStudioCompanion',
      platform: 'darwin',
      pathExists: () => true,
      spawnProcess: (command, args) => {
        launches.push({ command, args })
        return child
      }
    })
    const lifecycle = result.lifecycle
    if (lifecycle === null) throw new Error('expected Studio lifecycle to start')

    expect(launches).toEqual([{ command: '/fake/TaskWraithStudioCompanion', args: ['--viewer'] }])
    expect(lifecycle.paths.allowedMediaRoot).toBe(nodePath.join(root, TRANSCRIPT_MEDIA_ASSET_DIR))

    const outsidePath = nodePath.join(root, 'outside.mov')
    await fsPromises.writeFile(outsidePath, 'outside')
    await expect(
      lifecycle.store.openMedia(0, {
        assetId: 'outside',
        path: outsidePath,
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_params', currentRevision: 0 })

    const insidePath = nodePath.join(root, TRANSCRIPT_MEDIA_ASSET_DIR, 'owned.mov')
    await fsPromises.writeFile(insidePath, 'owned')
    await expect(
      lifecycle.store.openMedia(0, {
        assetId: 'owned',
        path: insidePath,
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({
      ok: true,
      revision: 1,
      asset: { assetId: 'owned', path: await fsPromises.realpath(insidePath) }
    })

    await lifecycle.dispose()
    expect(lifecycle.status().state).toBe('stopped')
    await expect(
      lifecycle.store.openMedia(1, {
        assetId: 'closed',
        path: insidePath,
        mediaKind: 'video'
      })
    ).rejects.toThrow('StudioRevisionStore is closed')
  })
})
