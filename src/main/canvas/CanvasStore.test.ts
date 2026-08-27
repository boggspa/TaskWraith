import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasStore } from './CanvasStore'
import type { CanvasEventRecord, CanvasSessionRecord } from './canvasTypes'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync) }
})

function session(id: string, over: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    schemaVersion: 1,
    id,
    driver: 'web',
    url: 'http://localhost:3000',
    title: 'title',
    viewport: { width: 1280, height: 800 },
    status: 'active',
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
    ...over
  }
}

function event(id: string, canvasId: string, over: Partial<CanvasEventRecord> = {}): CanvasEventRecord {
  return {
    schemaVersion: 1,
    id,
    canvasId,
    kind: 'snapshot',
    createdAt: '2026-06-21T00:00:00.000Z',
    ...over
  }
}

describe('CanvasStore', () => {
  let dir: string
  let store: CanvasStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-store-'))
    store = new CanvasStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('listSessions soft-empties on corrupt JSON; listSessionsStrict fails closed', () => {
    writeFileSync(join(dir, 'canvas-sessions.json'), '{not-json')
    // Best-effort product path keeps UI up with an empty list.
    expect(store.listSessions()).toEqual([])
    // Host honesty path must not paint a false-empty artifacts family.
    expect(() => store.listSessionsStrict()).toThrow()
  })

  it('listSessionsStrict treats a missing sessions file as measured none', () => {
    expect(store.listSessionsStrict()).toEqual([])
  })

  it('round-trips sessions and is idempotent on id', () => {
    store.upsertSession(session('a'))
    store.upsertSession(session('a', { status: 'closed' }))
    expect(store.listSessions()).toHaveLength(1)
    expect(store.getSession('a')?.status).toBe('closed')
  })

  it('persists across store instances', () => {
    store.upsertSession(session('a'))
    const reopened = new CanvasStore(dir)
    expect(reopened.getSession('a')?.url).toBe('http://localhost:3000')
  })

  it('preserves non-web canvas driver kinds', () => {
    store.upsertSession(session('html', { driver: 'html' }))
    store.upsertSession(session('image', { driver: 'image' }))
    store.upsertSession(session('sketch', { driver: 'sketch' }))
    expect(store.getSession('html')?.driver).toBe('html')
    expect(store.getSession('image')?.driver).toBe('image')
    expect(store.getSession('sketch')?.driver).toBe('sketch')
  })

  it('rejects records without an id', () => {
    expect(() => store.upsertSession(session(''))).toThrow()
  })

  it('appends events, filters by canvasId', () => {
    store.appendEvent(event('e1', 'a'))
    store.appendEvent(event('e2', 'b'))
    store.appendEvent(event('e3', 'a', { kind: 'screenshot' }))
    expect(store.listEvents('a')).toHaveLength(2)
    expect(store.listEvents()).toHaveLength(3)
    expect(store.listEvents('a').map((e) => e.kind)).toEqual(['snapshot', 'screenshot'])
  })

  it('offers a strict event append that propagates persistence failures', () => {
    const blockedPath = join(dir, 'not-a-directory')
    writeFileSync(blockedPath, 'file')
    const blockedStore = new CanvasStore(blockedPath)

    expect(() => blockedStore.appendEventStrict(event('strict-e1', 'a'))).toThrow()
    // Ordinary canvas history remains best-effort for compatibility.
    expect(() => blockedStore.appendEvent(event('best-effort-e1', 'a'))).not.toThrow()
  })

  it('claims an eval approval id durably and rejects replay', () => {
    const started = event('eval-start-1', 'a', {
      kind: 'eval.started',
      approvalId: 'approval-single-use',
      detail: {
        approvalId: 'approval-single-use',
        scriptHashAlgorithm: 'sha256',
        scriptHash: 'a'.repeat(64),
        scriptLength: 3,
        scriptByteLength: 3
      }
    })
    store.appendEventStrict(started)
    expect(() =>
      store.appendEventStrict({ ...started, id: 'eval-start-replay' })
    ).toThrow('already been consumed')

    const reopened = new CanvasStore(dir)
    expect(() =>
      reopened.appendEventStrict({ ...started, id: 'eval-start-after-restart' })
    ).toThrow('already been consumed')
  })

  it('rejects a hardlinked approval-use ledger without modifying its peer', () => {
    const victimPath = join(dir, 'approval-hardlink-victim.json')
    const ledgerPath = join(dir, 'canvas-eval-approval-uses.json')
    writeFileSync(victimPath, '[]')
    fs.linkSync(victimPath, ledgerPath)

    expect(() =>
      store.appendEventStrict(
        event('hardlink-start', 'a', {
          kind: 'eval.started',
          approvalId: 'approval-hardlink',
          detail: { approvalId: 'approval-hardlink' }
        })
      )
    ).toThrow('private regular file')
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('[]')
  })

  it('rejects symlinked and hardlinked strict event history', () => {
    const eventsPath = join(dir, 'canvas-events.json')
    const symlinkVictim = join(dir, 'events-symlink-victim.json')
    writeFileSync(symlinkVictim, '[]')
    fs.symlinkSync(symlinkVictim, eventsPath)
    expect(() =>
      store.appendEventStrict(event('symlink-event', 'a', { kind: 'eval.completed' }))
    ).toThrow()
    expect(fs.readFileSync(symlinkVictim, 'utf8')).toBe('[]')

    fs.unlinkSync(eventsPath)
    const hardlinkVictim = join(dir, 'events-hardlink-victim.json')
    writeFileSync(hardlinkVictim, '[]')
    fs.linkSync(hardlinkVictim, eventsPath)
    expect(() =>
      store.appendEventStrict(event('hardlink-event', 'a', { kind: 'eval.completed' }))
    ).toThrow('private regular file')
    expect(fs.readFileSync(hardlinkVictim, 'utf8')).toBe('[]')
  })

  it('uses exclusive no-follow temp creation when an attacker precreates a temp symlink', () => {
    const victimPath = join(dir, 'temp-symlink-victim.json')
    writeFileSync(victimPath, 'VICTIM-MUST-STAY')
    const openMock = vi.mocked(fs.openSync)
    const realOpenSync = openMock.getMockImplementation()
    if (!realOpenSync) throw new Error('Expected the fs.openSync passthrough mock.')
    let planted = false
    openMock.mockImplementation(
      ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (!planted && String(filePath).endsWith('.tmp')) {
          planted = true
          fs.symlinkSync(victimPath, filePath)
        }
        return realOpenSync(filePath, flags, mode)
      }) as typeof fs.openSync
    )
    try {
      expect(() =>
        store.appendEventStrict(
          event('temp-symlink-start', 'a', {
            kind: 'eval.started',
            approvalId: 'approval-temp-symlink',
            detail: { approvalId: 'approval-temp-symlink' }
          })
        )
      ).toThrow()
      expect(planted).toBe(true)
      expect(fs.readFileSync(victimPath, 'utf8')).toBe('VICTIM-MUST-STAY')
    } finally {
      openMock.mockImplementation(realOpenSync)
    }
  })

  it('detects a pathname swap between open and lstat by comparing dev and ino', () => {
    store.appendEventStrict(event('existing-event', 'a', { kind: 'eval.completed' }))
    const eventsPath = join(dir, 'canvas-events.json')
    const originalBackup = join(dir, 'canvas-events.original.json')
    const replacementPath = join(dir, 'canvas-events.replacement.json')
    writeFileSync(replacementPath, '[]', { mode: 0o600 })
    const openMock = vi.mocked(fs.openSync)
    const realOpenSync = openMock.getMockImplementation()
    if (!realOpenSync) throw new Error('Expected the fs.openSync passthrough mock.')
    let swapped = false
    openMock.mockImplementation(
      ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fd = realOpenSync(filePath, flags, mode)
        if (!swapped && String(filePath) === eventsPath) {
          swapped = true
          fs.renameSync(eventsPath, originalBackup)
          fs.renameSync(replacementPath, eventsPath)
        }
        return fd
      }) as typeof fs.openSync
    )
    try {
      expect(() =>
        store.appendEventStrict(event('after-swap', 'a', { kind: 'eval.completed' }))
      ).toThrow('changed while it was being opened')
      expect(swapped).toBe(true)
    } finally {
      openMock.mockImplementation(realOpenSync)
    }
  })

  it('rejects a directory swap at no-follow open without chmodding the symlink target', () => {
    if (process.platform === 'win32') return
    const victimDir = mkdtempSync(join(tmpdir(), 'canvas-dir-swap-victim-'))
    const victimFile = join(victimDir, 'must-stay.txt')
    const originalDir = `${dir}-original`
    writeFileSync(victimFile, 'UNCHANGED')
    fs.chmodSync(victimDir, 0o755)
    const openMock = vi.mocked(fs.openSync)
    const realOpenSync = openMock.getMockImplementation()
    if (!realOpenSync) throw new Error('Expected the fs.openSync passthrough mock.')
    let swapped = false
    openMock.mockImplementation(
      ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
          !swapped &&
          String(filePath) === dir &&
          typeof flags === 'number' &&
          (flags & (fs.constants.O_DIRECTORY ?? 0)) !== 0
        ) {
          swapped = true
          fs.renameSync(dir, originalDir)
          fs.symlinkSync(victimDir, dir, 'dir')
        }
        return realOpenSync(filePath, flags, mode)
      }) as typeof fs.openSync
    )
    try {
      expect(() =>
        store.appendEventStrict(event('dir-swap', 'a', { kind: 'eval.completed' }))
      ).toThrow()
      expect(swapped).toBe(true)
      expect(fs.readFileSync(victimFile, 'utf8')).toBe('UNCHANGED')
      expect(fs.statSync(victimDir).mode & 0o077).toBe(0o055)
    } finally {
      openMock.mockImplementation(realOpenSync)
      try {
        fs.unlinkSync(dir)
      } catch {
        // The no-follow open may have failed before the link was installed.
      }
      if (fs.existsSync(originalDir)) fs.renameSync(originalDir, dir)
      rmSync(victimDir, { recursive: true, force: true })
    }
  })

  it('keeps strict files private and rejects a substituted base symlink without following it', () => {
    store.appendEventStrict(event('private-event', 'a', { kind: 'eval.completed' }))
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o077).toBe(0)
      expect(fs.statSync(join(dir, 'canvas-events.json')).mode & 0o077).toBe(0)
    }

    const victimDir = mkdtempSync(join(tmpdir(), 'canvas-clear-victim-'))
    const victimFile = join(victimDir, 'must-survive.txt')
    writeFileSync(victimFile, 'SURVIVE')
    rmSync(dir, { recursive: true, force: true })
    fs.symlinkSync(victimDir, dir, 'dir')
    try {
      expect(() => store.clearAll()).toThrow(/redirected/)
      expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(victimFile, 'utf8')).toBe('SURVIVE')
    } finally {
      fs.unlinkSync(dir)
      rmSync(victimDir, { recursive: true, force: true })
    }
  })

  it('binds clearAll to the directory observed before its operation-wide open', () => {
    // Directory-handle identity (dev/ino after an O_DIRECTORY open) is not
    // reliable under Windows rename races the way POSIX inode identity is.
    // Sibling directory-swap coverage above already skips win32 for the same reason.
    if (process.platform === 'win32') return
    store.appendEventStrict(event('must-clear-original', 'a', { kind: 'eval.completed' }))
    const originalDir = `${dir}-original`
    const replacementDir = mkdtempSync(join(tmpdir(), 'canvas-clear-replacement-'))
    writeFileSync(join(replacementDir, 'canvas-events.json'), '[]', { mode: 0o600 })
    const openMock = vi.mocked(fs.openSync)
    const realOpenSync = openMock.getMockImplementation()
    if (!realOpenSync) throw new Error('Expected the fs.openSync passthrough mock.')
    let swapped = false
    openMock.mockImplementation(
      ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
          !swapped &&
          String(filePath) === dir &&
          typeof flags === 'number' &&
          (flags & (fs.constants.O_DIRECTORY ?? 0)) !== 0
        ) {
          swapped = true
          fs.renameSync(dir, originalDir)
          fs.renameSync(replacementDir, dir)
        }
        return realOpenSync(filePath, flags, mode)
      }) as typeof fs.openSync
    )
    try {
      expect(() => store.clearAll()).toThrow(/changed while it was being opened/)
      expect(swapped).toBe(true)
      expect(fs.readFileSync(join(originalDir, 'canvas-events.json'), 'utf8')).toContain(
        'must-clear-original'
      )
    } finally {
      openMock.mockImplementation(realOpenSync)
      rmSync(dir, { recursive: true, force: true })
      if (fs.existsSync(originalDir)) fs.renameSync(originalDir, dir)
      rmSync(replacementDir, { recursive: true, force: true })
    }
  })

  it('pins eval receipt claim and audit event to one directory identity', () => {
    // Same win32 directory-identity limitation as the clearAll open-pin test.
    if (process.platform === 'win32') return
    const originalDir = `${dir}-original`
    const replacementDir = mkdtempSync(join(tmpdir(), 'canvas-eval-replacement-'))
    writeFileSync(join(replacementDir, 'canvas-events.json'), '[]', { mode: 0o600 })
    writeFileSync(join(replacementDir, 'canvas-eval-approval-uses.json'), '[]', { mode: 0o600 })
    const openMock = vi.mocked(fs.openSync)
    const realOpenSync = openMock.getMockImplementation()
    if (!realOpenSync) throw new Error('Expected the fs.openSync passthrough mock.')
    let directoryOpenCount = 0
    let swapped = false
    openMock.mockImplementation(
      ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
          String(filePath) === dir &&
          typeof flags === 'number' &&
          (flags & (fs.constants.O_DIRECTORY ?? 0)) !== 0
        ) {
          directoryOpenCount += 1
          // Outer pin, receipt read, and receipt write have completed. Swap
          // before the event read: the same pinned identity must reject it.
          if (!swapped && directoryOpenCount === 4) {
            swapped = true
            fs.renameSync(dir, originalDir)
            fs.renameSync(replacementDir, dir)
          }
        }
        return realOpenSync(filePath, flags, mode)
      }) as typeof fs.openSync
    )
    const started = event('eval-split-start', 'a', {
      kind: 'eval.started',
      approvalId: 'approval-operation-pin',
      detail: { approvalId: 'approval-operation-pin' }
    })
    try {
      expect(() => store.appendEventStrict(started)).toThrow()
      expect(swapped).toBe(true)
      expect(
        JSON.parse(
          fs.readFileSync(join(originalDir, 'canvas-eval-approval-uses.json'), 'utf8')
        )
      ).toContain('approval-operation-pin')
      const originalEventsPath = join(originalDir, 'canvas-events.json')
      expect(
        fs.existsSync(originalEventsPath)
          ? fs.readFileSync(originalEventsPath, 'utf8').includes('eval-split-start')
          : false
      ).toBe(false)
      expect(fs.readFileSync(join(dir, 'canvas-events.json'), 'utf8')).not.toContain(
        'eval-split-start'
      )
    } finally {
      openMock.mockImplementation(realOpenSync)
      rmSync(dir, { recursive: true, force: true })
      if (fs.existsSync(originalDir)) fs.renameSync(originalDir, dir)
      rmSync(replacementDir, { recursive: true, force: true })
    }
  })

  it('normalizes a screenshot event to metadata only (no pixel field round-trips unredacted)', () => {
    store.appendEvent(event('e1', 'a', { kind: 'screenshot', detail: { frameHash: 'abc', width: 10, height: 20 } }))
    const [evt] = store.listEvents('a')
    expect(evt.detail).toEqual({ frameHash: 'abc', width: 10, height: 20 })
  })

  it('defensively strips raw script, value, and error fields from eval receipts', () => {
    store.appendEventStrict(
      event('eval-1', 'a', {
        kind: 'eval.completed',
        approvalId: 'approval-1',
        detail: {
          approvalId: 'approval-1',
          scriptHashAlgorithm: 'sha256',
          scriptHash: 'abc',
          scriptLength: 7,
          scriptByteLength: 7,
          outcome: 'success',
          ok: true,
          script: 'STORE-SCRIPT-SECRET',
          value: 'STORE-RESULT-SECRET',
          error: 'STORE-ERROR-SECRET',
          raw: { script: 'NESTED-SECRET' }
        }
      })
    )

    const [persisted] = new CanvasStore(dir).listEvents('a')
    expect(persisted).toMatchObject({
      approvalId: 'approval-1',
      detail: {
        approvalId: 'approval-1',
        scriptHash: 'abc',
        outcome: 'success',
        ok: true
      }
    })
    expect(JSON.stringify(persisted)).not.toContain('STORE-')
    expect(JSON.stringify(persisted)).not.toContain('NESTED-SECRET')
  })

  it('continues to load legacy unbound eval records without inventing an approval id', () => {
    store.appendEvent(
      event('legacy-eval', 'a', {
        kind: 'eval',
        detail: { scriptHash: 'legacy-hash', scriptLength: 3, ok: true }
      })
    )
    expect(new CanvasStore(dir).listEvents('a')[0]).toMatchObject({
      kind: 'eval',
      approvalId: undefined,
      detail: { scriptHash: 'legacy-hash', scriptLength: 3, ok: true }
    })
  })

  it('persists sketch documents by scope until explicitly overwritten', () => {
    store.upsertSketchDocument('chat:one', {
      schemaVersion: 1,
      title: 'Sketch Canvas',
      viewport: { width: 800, height: 600 },
      elements: [{ id: 'label', kind: 'text', x: 10, y: 20, text: 'hello' }],
      updatedAt: '2026-06-21T00:00:00.000Z'
    })
    const reopened = new CanvasStore(dir)
    expect(reopened.getSketchDocument('chat:one')?.elements).toEqual([
      { id: 'label', kind: 'text', x: 10, y: 20, text: 'hello' }
    ])
    reopened.upsertSketchDocument('chat:one', {
      schemaVersion: 1,
      title: 'Sketch Canvas',
      viewport: { width: 800, height: 600 },
      elements: [],
      updatedAt: '2026-06-21T00:01:00.000Z'
    })
    expect(store.getSketchDocument('chat:one')?.elements).toEqual([])
  })
})
