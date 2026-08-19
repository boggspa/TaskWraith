import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { TRANSCRIPT_MEDIA_ASSET_DIR } from '../services/TranscriptMediaAssetStore'
import type { StudioCompanionChild } from './StudioCompanionSupervisor'
import { importStudioEffectPreview } from './StudioEffectPreviewSource'
import { STUDIO_METHODS, STUDIO_TRANSCRIPT_SCHEMA_VERSION } from './StudioProtocol'
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
        pathExists: (path) => path.split(nodePath.sep).includes('debug')
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
    await expect(
      lifecycle.setTranscript({
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        transcriptId: 'not-hydrated',
        assetId: 'owned',
        segments: []
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'companion_not_ready',
      currentRevision: 0
    })

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

  it('turns an owner-authorized cube into a delivered preview and refuses one outside the root', async () => {
    // The public host seam had no test at all: deleting setEffectPreview, or the
    // loader call inside it, left Studio TS green. This drives the REAL
    // lifecycle -> loader -> store -> supervisor path and reads the exact bytes
    // the companion receives, rather than asserting a returned shape.
    const root = await temporaryRoot()
    const child = new FakeStudioChild()
    const result = await startStudioProductionLifecycle({
      userDataPath: root,
      binaryPath: '/fake/TaskWraithStudioCompanion',
      platform: 'darwin',
      pathExists: () => true,
      spawnProcess: () => child
    })
    const lifecycle = result.lifecycle
    if (lifecycle === null) throw new Error('expected Studio lifecycle to start')

    const written: Record<string, unknown>[] = []
    let pending = ''
    child.stdin.on('data', (chunk) => {
      pending += String(chunk)
      for (let cut = pending.indexOf('\n'); cut !== -1; cut = pending.indexOf('\n')) {
        const line = pending.slice(0, cut).trim()
        pending = pending.slice(cut + 1)
        if (line) written.push(JSON.parse(line))
      }
    })
    const until = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000
      while (Date.now() <= deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('timed out waiting for the companion write')
    }

    // Real hydration handshake — the supervisor refuses delivery until it has one.
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: STUDIO_METHODS.hello, params: { protocolVersion: 1 } })}\n`
    )
    await until(() => written.length >= 1)
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: STUDIO_METHODS.getDocument })}\n`
    )
    await until(() => written.length >= 2)

    const cubeText = `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, () => '0.5 0.5 0.5').join('\n')}\n`
    const effectId = createHash('sha256').update(cubeText, 'utf8').digest('hex')
    // Faithful to production: the operator's file lives OUTSIDE every owned
    // root — as it always does — and reaches the jail only through the real
    // import hop. This test used to write the cube straight into
    // `allowedMediaRoot`, which hid the fact that the jail pointed at the
    // transcript-media CAS, a directory a `.cube` can never legitimately
    // occupy. That made `setEffectPreview` unsatisfiable in production while
    // this suite stayed green.
    const operatorCube = nodePath.join(root, 'operator-files', 'look.cube')
    await fsPromises.mkdir(nodePath.dirname(operatorCube), { recursive: true })
    await fsPromises.writeFile(operatorCube, cubeText, 'utf8')
    const imported = importStudioEffectPreview({
      sourcePath: operatorCube,
      destinationRoot: lifecycle.paths.effectPreviewRoot
    })

    await expect(lifecycle.setEffectPreview(imported.path)).resolves.toMatchObject({
      ok: true,
      revision: 1,
      effectPreview: { effectId, cubeByteLength: Buffer.byteLength(cubeText, 'utf8') }
    })
    await until(() => written.length >= 3)
    expect(written[2]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: { revision: 1, op: { type: 'set_effect_preview', effectPreview: { effectId } } }
    })
    // The operator's path must not travel to the companion.
    expect(JSON.stringify(written[2])).not.toContain('look.cube')
    expect(JSON.stringify(written[2])).not.toContain(root)

    // A cube outside the owned root is refused with a typed code, commits no
    // revision, and delivers nothing.
    const outsideCube = nodePath.join(root, 'outside.cube')
    await fsPromises.writeFile(outsideCube, cubeText, 'utf8')
    await expect(lifecycle.setEffectPreview(outsideCube)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params',
      currentRevision: 1
    })
    expect((await lifecycle.setEffectPreview(outsideCube)) as { message: string }).toMatchObject({
      message: expect.stringContaining('path_outside_allowed_roots')
    })
    expect(written).toHaveLength(3)
    expect(lifecycle.store.getDocument().effectPreview).toMatchObject({ effectId })

    await expect(lifecycle.setEffectPreview(null)).resolves.toMatchObject({
      ok: true,
      revision: 2,
      effectPreview: null
    })
    await until(() => written.length >= 4)
    expect(written[3]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: { revision: 2, op: { type: 'set_effect_preview', effectPreview: null } }
    })
    expect(lifecycle.store.getDocument().effectPreview).toBeNull()

    await lifecycle.dispose()
  })
})
