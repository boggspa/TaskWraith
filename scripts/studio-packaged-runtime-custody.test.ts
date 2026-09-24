import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<Writable | void>
  createPackageWithOptions: (
    source: string,
    destination: string,
    options: { unpack: string }
  ) => Promise<Writable | void>
  uncache: (archive: string) => void
}
type Manifest = Array<{ path: string; byteLength: number; sha256: string }>
type Receipt = {
  schemaVersion: number
  ok: boolean
  repoRoot: string
  appRoot: string
  electron: { fileCount: number; byteLength: number; manifestSha256: string; manifest: Manifest }
  host: { fileCount: number; byteLength: number; manifestSha256: string; manifest: Manifest }
}
const { assertPackagedRuntimeCustody } = require('./studio-packaged-runtime-custody.cjs') as {
  assertPackagedRuntimeCustody: (options: { repoRoot: string; appRoot: string }) => Receipt
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function hash(contents: string): string {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-runtime-custody-'))
  tempRoots.push(root)
  const repoRoot = path.join(root, 'repo')
  const appRoot = path.join(root, 'TaskWraith Test.app')
  const resources = path.join(appRoot, 'Contents', 'Resources')
  const staging = path.join(root, 'archive-input')
  const archive = path.join(resources, 'app.asar')
  for (const [relative, contents] of Object.entries({
    'out/main/index.js': 'main-v1',
    'out/main/nested/chunk.js': 'chunk-v1',
    'out/preload/index.js': 'preload-v1',
    'out/renderer/index.html': 'renderer-v1'
  })) {
    write(path.join(repoRoot, relative), contents)
    write(path.join(staging, relative), contents)
  }
  write(path.join(repoRoot, 'out/host/cli.js'), 'host-v1')
  write(path.join(repoRoot, 'out/host/nested/worker.js'), 'worker-v1')
  write(path.join(resources, 'host/cli.js'), 'host-v1')
  write(path.join(resources, 'host/nested/worker.js'), 'worker-v1')
  write(path.join(staging, 'package.json'), '{"version":"test"}')
  write(path.join(staging, 'resources/unrelated.txt'), 'metadata outside custody')
  write(path.join(resources, 'unrelated.txt'), 'unrelated resource')
  async function pack(unpack?: string): Promise<void> {
    const stream = unpack
      ? await asar.createPackageWithOptions(staging, archive, { unpack })
      : await asar.createPackage(staging, archive)
    // asar 3.x resolves before its Writable finishes populating payload slots.
    if (stream) await finished(stream)
  }
  await pack()
  return { repoRoot, appRoot, resources, staging, archive, pack }
}

describe('Studio packaged runtime custody', () => {
  it('returns deterministic manifests for exact current Electron and Host bytes', async () => {
    const f = await fixture()
    const result = assertPackagedRuntimeCustody(f)
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      repoRoot: f.repoRoot,
      appRoot: f.appRoot
    })
    expect(result.electron.fileCount).toBe(4)
    expect(result.host.fileCount).toBe(2)
    expect(result.electron.manifest.map((entry) => entry.path)).toEqual([
      'out/main/index.js',
      'out/main/nested/chunk.js',
      'out/preload/index.js',
      'out/renderer/index.html'
    ])
    expect(result.host.manifest).toEqual([
      { path: 'cli.js', byteLength: 7, sha256: hash('host-v1') },
      { path: 'nested/worker.js', byteLength: 9, sha256: hash('worker-v1') }
    ])
    for (const item of [result.electron, result.host]) {
      expect(item.manifestSha256).toBe(hash(JSON.stringify(item.manifest)))
      expect(item.byteLength).toBe(
        item.manifest.reduce((total, entry) => total + entry.byteLength, 0)
      )
    }
    expect(assertPackagedRuntimeCustody(f)).toEqual(result)
  })

  it.each(['electron', 'host'] as const)(
    'rejects changed %s bytes even when the file size is unchanged',
    async (target) => {
      const f = await fixture()
      if (target === 'electron') {
        write(path.join(f.staging, 'out/main/index.js'), 'main-v2')
        await f.pack()
      } else write(path.join(f.resources, 'host/cli.js'), 'host-v2')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/changed.*(?:index|cli)\.js/i)
    }
  )

  it.each(['electron', 'host'] as const)('rejects a missing %s packaged file', async (target) => {
    const f = await fixture()
    if (target === 'electron') {
      fs.unlinkSync(path.join(f.staging, 'out/main/nested/chunk.js'))
      await f.pack()
    } else fs.unlinkSync(path.join(f.resources, 'host/nested/worker.js'))
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/missing.*(?:chunk|worker)\.js/i)
  })

  it.each(['electron', 'host'] as const)('rejects an extra %s packaged file', async (target) => {
    const f = await fixture()
    if (target === 'electron') {
      write(path.join(f.staging, 'out/renderer/stale.js'), 'stale payload')
      await f.pack()
    } else write(path.join(f.resources, 'host/stale.js'), 'stale payload')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*stale\.js/i)
  })

  it('compares against current source bytes on every call', async () => {
    const f = await fixture()
    assertPackagedRuntimeCustody(f)
    write(path.join(f.repoRoot, 'out/preload/index.js'), 'preload-v2')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/changed.*preload\/index\.js/i)
  })

  it('reloads the archive header after an in-place package replacement', async () => {
    const f = await fixture()
    assertPackagedRuntimeCustody(f)
    write(path.join(f.staging, 'out/main/added.js'), 'extra')
    await f.pack()
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*added\.js/i)
  })

  it('ignores unrelated metadata and applies only the Host map/DS_Store filters', async () => {
    const f = await fixture()
    write(path.join(f.repoRoot, 'out/host/nested/worker.js.map'), 'source map')
    write(path.join(f.repoRoot, 'out/host/.DS_Store'), 'finder source')
    write(path.join(f.repoRoot, 'out/host/nested/.DS_Store'), 'nested finder source')
    write(path.join(f.staging, 'package.json'), '{"version":"other"}')
    write(path.join(f.staging, 'resources/extra.txt'), 'unrelated')
    await f.pack()
    expect(assertPackagedRuntimeCustody(f).host.fileCount).toBe(2)
    write(path.join(f.resources, 'host/not.map.js'), 'must compare')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*not\.map\.js/i)
  })

  it.each(['nested/worker.js.map', '.DS_Store'])(
    'rejects filtered Host file %s if it was copied into packaged resources',
    async (member) => {
      const f = await fixture()
      write(path.join(f.repoRoot, 'out/host', member), 'excluded source')
      write(path.join(f.resources, 'host', member), 'excluded source')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/Host runtime mismatch; extra/i)
    }
  )

  it('does not apply Host exclusions to Electron output', async () => {
    const f = await fixture()
    write(path.join(f.repoRoot, 'out/main/index.js.map'), 'required Electron map')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/missing.*index\.js\.map/i)
  })

  it.each(['cli.js', 'nested/worker.js.map', '.DS_Store'])(
    'rejects Host archive payload %s even if Host resource filters would exclude it',
    async (member) => {
      const f = await fixture()
      write(path.join(f.staging, 'out/host', member), 'mispackaged Host')
      await f.pack()
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(
        /Host file must not appear in app\.asar/i
      )
    }
  )

  it.each(['repoRoot', 'appRoot'] as const)('rejects invalid %s roots', async (field) => {
    const f = await fixture()
    for (const value of ['', 'relative/path', path.join(f.repoRoot, 'absent')]) {
      expect(() => assertPackagedRuntimeCustody({ ...f, [field]: value })).toThrow(/directory/)
    }
    const file = path.join(f.repoRoot, 'ordinary-file')
    write(file, 'not a directory')
    expect(() => assertPackagedRuntimeCustody({ ...f, [field]: file })).toThrow(/directory/)
  })

  it.each(['repoRoot', 'appRoot'] as const)('rejects a symlinked %s root', async (field) => {
    const f = await fixture()
    const linked = `${f[field]}-linked`
    fs.symlinkSync(f[field], linked, 'junction')
    for (const value of [linked, `${linked}${path.sep}`]) {
      expect(() => assertPackagedRuntimeCustody({ ...f, [field]: value })).toThrow(/symlink/i)
    }
  })

  it.each(['out/main', 'out/preload', 'out/renderer', 'out/host'])(
    'rejects a missing or empty build root %s',
    async (root) => {
      const f = await fixture()
      fs.rmSync(path.join(f.repoRoot, root), { recursive: true })
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/missing.*directory/i)
      fs.mkdirSync(path.join(f.repoRoot, root))
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/empty source runtime directory/i)
    }
  )

  it.each(['app.asar', 'host'])('rejects a missing packaged runtime root %s', async (root) => {
    const f = await fixture()
    fs.rmSync(path.join(f.resources, root), { recursive: true })
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/missing|unreadable/i)
  })

  it.each(['out', 'out/main', 'out/preload', 'out/renderer'])(
    'rejects a missing archive prefix %s',
    async (root) => {
      const f = await fixture()
      fs.rmSync(path.join(f.staging, root), { recursive: true })
      await f.pack()
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/archive directory/i)
    }
  )

  it.each([
    ['source file', 'repoRoot', 'out/main/index.js'],
    ['source directory', 'repoRoot', 'out/preload'],
    ['source out', 'repoRoot', 'out'],
    ['Host source', 'repoRoot', 'out/host/cli.js'],
    ['resource file', 'resources', 'host/cli.js'],
    ['resource directory', 'resources', 'host/nested'],
    ['archive file', 'resources', 'app.asar'],
    ['Resources directory', 'appRoot', 'Contents/Resources']
  ] as const)('rejects a %s symlink', async (_label, base, member) => {
    const f = await fixture()
    const original = path.join(f[base], member)
    const target = `${original}-link-target`
    fs.renameSync(original, target)
    fs.symlinkSync(target, original, fs.statSync(target).isDirectory() ? 'junction' : 'file')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/symlink/i)
  })

  it('rejects source and resource links even under excluded Host filenames', async () => {
    const f = await fixture()
    for (const base of [path.join(f.repoRoot, 'out/host'), path.join(f.resources, 'host')]) {
      const link = path.join(base, 'hidden.js.map')
      fs.symlinkSync(path.join(base, 'cli.js'), link, 'file')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/symlink/i)
      fs.unlinkSync(link)
    }
  })

  it.each(['out/main/linked.js', 'out/preload/linked'])(
    'rejects an archive symlink %s',
    async (member) => {
      const f = await fixture()
      const target = member.endsWith('.js') ? 'out/main/index.js' : 'out/main'
      fs.symlinkSync(
        path.join(f.staging, target),
        path.join(f.staging, member),
        member.endsWith('.js') ? 'file' : 'junction'
      )
      await f.pack()
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/archive symlink/i)
    }
  )

  it.each(['main', 'preload', 'renderer', 'host'])(
    'rejects an unindexed loose runtime file under out/%s',
    async (root) => {
      const f = await fixture()
      const rogue = path.join(f.resources, 'app.asar.unpacked/out', root, 'rogue.js')
      write(rogue, 'unindexed runtime')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*rogue\.js|Host file/i)
      // The same extra file must fail beside a legitimate indexed payload.
      await f.pack('**/chunk.js')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*rogue\.js|Host file/i)
    }
  )

  it.each(['main', 'preload', 'renderer', 'host'])(
    'rejects an unindexed symlink under unpacked out/%s',
    async (root) => {
      const f = await fixture()
      await f.pack('**/chunk.js')
      const link = path.join(f.resources, 'app.asar.unpacked/out', root, 'unindexed.js')
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(path.join(f.repoRoot, 'out/main/index.js'), link, 'file')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/symlink/i)
    }
  )

  it.each(['', 'out', 'out/main', 'out/preload', 'out/renderer', 'out/host'])(
    'rejects an unindexed unpacked tree symlink at %s',
    async (member) => {
      const f = await fixture()
      const link = path.join(f.resources, 'app.asar.unpacked', member)
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(path.join(f.repoRoot, 'out/main'), link, 'junction')
      expect(() => assertPackagedRuntimeCustody(f)).toThrow(/symlink/i)
    }
  )

  it('rejects loose copies of packed runtime files even when the bytes match', async () => {
    const f = await fixture()
    await f.pack('**/chunk.js')
    write(path.join(f.resources, 'app.asar.unpacked/out/main/index.js'), 'main-v1')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/extra.*out\/main\/index\.js/i)
  })

  it('allows absent unpacked trees and unrelated loose package resources', async () => {
    const f = await fixture()
    const expected = assertPackagedRuntimeCustody(f)
    write(path.join(f.resources, 'app.asar.unpacked/resources/unrelated.txt'), 'unrelated')
    expect(assertPackagedRuntimeCustody(f)).toEqual(expected)
    await f.pack('**/chunk.js')
    expect(assertPackagedRuntimeCustody(f)).toEqual(expected)
  })

  it('rejects a missing indexed unpacked runtime file', async () => {
    const f = await fixture()
    await f.pack('**/chunk.js')
    fs.unlinkSync(path.join(f.resources, 'app.asar.unpacked/out/main/nested/chunk.js'))
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/missing.*chunk\.js/i)
  })

  it('checks unpacked runtime payloads and rejects their filesystem symlinks', async () => {
    const f = await fixture()
    await f.pack('**/chunk.js')
    expect(assertPackagedRuntimeCustody(f).electron.fileCount).toBe(4)
    const unpacked = path.join(f.resources, 'app.asar.unpacked/out/main/nested/chunk.js')
    fs.unlinkSync(unpacked)
    fs.symlinkSync(path.join(f.repoRoot, 'out/main/nested/chunk.js'), unpacked, 'file')
    expect(() => assertPackagedRuntimeCustody(f)).toThrow(/symlink/i)
  })
})
