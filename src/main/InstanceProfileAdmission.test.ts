import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  admitPackagedIsolatedProfileRoot,
  admitPackagedIsolatedProfileRootSync,
  type InstanceProfileAdmissionFileSystem,
  type InstanceProfileAdmissionSyncFileSystem,
  type InstanceProfileDirectoryHandle,
  type InstanceProfileDirectoryHandleSync,
  type InstanceProfileDirectoryStat
} from './InstanceProfileAdmission'

type EntryKind = 'directory' | 'file' | 'symlink'

interface FakeEntry {
  kind: EntryKind
  uid: number
  mode: number
  dev: bigint
  ino: bigint
}

interface FakeEntryInput {
  kind: EntryKind
  uid: number
  mode: number
  dev?: bigint
  ino?: bigint
}

class FakeProfileFileSystem
  implements InstanceProfileAdmissionFileSystem, InstanceProfileAdmissionSyncFileSystem
{
  readonly entries = new Map<string, FakeEntry>()
  readonly mkdirCalls: string[] = []
  readonly pathChmodCalls: Array<{ path: string; mode: number }> = []
  readonly descriptorChmodCalls: Array<{ path: string; mode: number }> = []
  readonly externalTargetChmodCalls: Array<{ path: string; target: string; mode: number }> = []
  private readonly symlinkTargets = new Map<string, string>()
  private readonly pendingLstatFailures = new Map<string, number>()
  private readonly failedDescriptorChmods = new Set<string>()
  private nextIno = 100n

  onBeforeDescriptorChmod?: (path: string) => void
  onAfterLstat?: (path: string) => void
  omitIdentity = false

  constructor(private readonly createUid: number) {}

  add(path: string, entry: FakeEntryInput): void {
    this.entries.set(path, {
      ...entry,
      dev: entry.dev ?? 1n,
      ino: entry.ino ?? this.nextIno++
    })
  }

  replaceWithSymlink(path: string, target: string): void {
    this.add(path, { kind: 'symlink', uid: this.createUid, mode: 0o777 })
    this.symlinkTargets.set(path, target)
  }

  failNextLstat(path: string): void {
    this.pendingLstatFailures.set(path, (this.pendingLstatFailures.get(path) || 0) + 1)
  }

  failDescriptorChmod(path: string): void {
    this.failedDescriptorChmods.add(path)
  }

  private mkdirImpl(path: string, options: { mode: number }): void {
    this.mkdirCalls.push(path)
    if (this.entries.has(path)) {
      const error = new Error('already exists') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      throw error
    }
    this.add(path, { kind: 'directory', uid: this.createUid, mode: options.mode })
  }

  async mkdir(path: string, options: { mode: number }): Promise<void> {
    this.mkdirSync(path, options)
  }

  mkdirSync(path: string, options: { mode: number }): void {
    this.mkdirImpl(path, options)
  }

  private statFor(entry: FakeEntry): InstanceProfileDirectoryStat {
    const snapshot = { ...entry }
    return {
      uid: snapshot.uid,
      mode: snapshot.mode,
      dev: this.omitIdentity ? undefined : snapshot.dev,
      ino: this.omitIdentity ? undefined : snapshot.ino,
      isDirectory: () => snapshot.kind === 'directory',
      isSymbolicLink: () => snapshot.kind === 'symlink'
    }
  }

  private lstatImpl(path: string): InstanceProfileDirectoryStat {
    const remainingFailures = this.pendingLstatFailures.get(path) || 0
    if (remainingFailures > 0) {
      this.pendingLstatFailures.set(path, remainingFailures - 1)
      throw new Error('injected lstat failure')
    }
    const entry = this.entries.get(path)
    if (!entry) {
      const error = new Error('missing') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    const stat = this.statFor(entry)
    this.onAfterLstat?.(path)
    return stat
  }

  async lstat(path: string): Promise<InstanceProfileDirectoryStat> {
    return this.lstatSync(path)
  }

  lstatSync(path: string): InstanceProfileDirectoryStat {
    return this.lstatImpl(path)
  }

  private chmodImpl(path: string, mode: number): void {
    const entry = this.entries.get(path)
    if (!entry) throw new Error('missing')
    const target = entry.kind === 'symlink' ? this.symlinkTargets.get(path) : path
    if (!target) throw new Error('broken link')
    const targetEntry = this.entries.get(target)
    if (!targetEntry) throw new Error('missing target')
    this.pathChmodCalls.push({ path, mode })
    if (target !== path) this.externalTargetChmodCalls.push({ path, target, mode })
    targetEntry.mode = mode
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.chmodSync(path, mode)
  }

  chmodSync(path: string, mode: number): void {
    this.chmodImpl(path, mode)
  }

  async openDirectory(path: string): Promise<InstanceProfileDirectoryHandle> {
    const handle = this.openDirectorySync(path)
    return {
      stat: async () => handle.statSync(),
      chmod: async (mode) => handle.chmodSync(mode),
      close: async () => handle.closeSync()
    }
  }

  openDirectorySync(path: string): InstanceProfileDirectoryHandleSync {
    const entry = this.entries.get(path)
    if (!entry || entry.kind !== 'directory') {
      const error = new Error('not a directory') as NodeJS.ErrnoException
      error.code = entry?.kind === 'symlink' ? 'ELOOP' : 'ENOENT'
      throw error
    }
    // This captured object models an O_NOFOLLOW descriptor: replacing the path
    // later does not retarget its fstat/fchmod operations.
    const pinnedEntry = entry
    return {
      statSync: () => this.statFor(pinnedEntry),
      chmodSync: (mode) => {
        this.onBeforeDescriptorChmod?.(path)
        this.descriptorChmodCalls.push({ path, mode })
        if (this.failedDescriptorChmods.has(path)) {
          throw new Error('injected descriptor chmod failure')
        }
        pinnedEntry.mode = mode
      },
      closeSync: () => undefined
    }
  }
}

const appDataPath = '/Users/example/Library/Application Support'
const currentUid = 501
const instanceId = 'a'.repeat(32)
const profileParentPath = join(appDataPath, 'TaskWraith Instances')
const profileRootPath = join(profileParentPath, instanceId)
const externalTargetPath = '/Users/example/external-private-directory'

function admissionInput(fileSystem: FakeProfileFileSystem) {
  return {
    appDataPath,
    instanceId,
    fileSystem,
    getCurrentUid: () => currentUid
  }
}

function addExistingDirectories(fileSystem: FakeProfileFileSystem, leafMode = 0o700): void {
  fileSystem.add(profileParentPath, { kind: 'directory', uid: currentUid, mode: 0o700 })
  fileSystem.add(profileRootPath, { kind: 'directory', uid: currentUid, mode: leafMode })
}

describe('admitPackagedIsolatedProfileRoot', () => {
  it('offers the same admission contract synchronously before userData initialization', () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)

    expect(admitPackagedIsolatedProfileRootSync(admissionInput(fileSystem))).toEqual({
      profileParentPath,
      profileRootPath,
      parentCreated: true,
      profileCreated: true
    })
    expect(fileSystem.entries.get(profileRootPath)).toMatchObject({
      kind: 'directory',
      uid: currentUid,
      mode: 0o700
    })
  })

  it('creates only the controlled parent and leaf as uid-owned 0700 directories', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).resolves.toEqual({
      profileParentPath,
      profileRootPath,
      parentCreated: true,
      profileCreated: true
    })
    expect(fileSystem.mkdirCalls).toEqual([profileParentPath, profileRootPath])
    expect(fileSystem.entries.get(profileParentPath)).toMatchObject({
      kind: 'directory',
      uid: currentUid,
      mode: 0o700
    })
    expect(fileSystem.entries.get(profileRootPath)).toMatchObject({
      kind: 'directory',
      uid: currentUid,
      mode: 0o700
    })
  })

  it('tightens an existing owned directory through its pinned descriptor', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)

    const admitted = await admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))

    expect(admitted).toMatchObject({ parentCreated: false, profileCreated: false })
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.descriptorChmodCalls).toEqual([{ path: profileRootPath, mode: 0o700 }])
    expect(fileSystem.entries.get(profileRootPath)?.mode).toBe(0o700)
  })

  it('rejects an unexpected parent link before touching the profile leaf', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    fileSystem.add(profileParentPath, { kind: 'symlink', uid: currentUid, mode: 0o777 })

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.mkdirCalls).toEqual([profileParentPath])
    expect(fileSystem.entries.has(profileRootPath)).toBe(false)
  })

  it('rejects existing non-directory, link, or foreign-owned profile leaves', async () => {
    for (const entry of [
      { kind: 'file' as const, uid: currentUid, mode: 0o600 },
      { kind: 'symlink' as const, uid: currentUid, mode: 0o777 },
      { kind: 'directory' as const, uid: currentUid + 1, mode: 0o700 }
    ]) {
      const fileSystem = new FakeProfileFileSystem(currentUid)
      fileSystem.add(profileParentPath, { kind: 'directory', uid: currentUid, mode: 0o700 })
      fileSystem.add(profileRootPath, entry)

      await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
        'Packaged isolated profile directory admission was rejected.'
      )
    }
  })

  it('fails before filesystem mutation when the profile is not a controlled appData descendant', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)

    await expect(
      admitPackagedIsolatedProfileRoot({
        ...admissionInput(fileSystem),
        appDataPath: '/',
        instanceId: '../not-an-instance'
      })
    ).rejects.toThrow('Packaged isolated profile admission is unavailable.')
    expect(fileSystem.mkdirCalls).toEqual([])
  })

  it('rejects a leaf swapped to a link before descriptor chmod without chmodding its external target', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)
    fileSystem.add(externalTargetPath, { kind: 'directory', uid: currentUid, mode: 0o755 })
    fileSystem.onBeforeDescriptorChmod = (path) => {
      if (path === profileRootPath) fileSystem.replaceWithSymlink(path, externalTargetPath)
    }

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.entries.get(profileRootPath)?.kind).toBe('symlink')
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.externalTargetChmodCalls).toEqual([])
    expect(fileSystem.entries.get(externalTargetPath)?.mode).toBe(0o755)
  })

  it('rejects the synchronous swap-before-chmod race without chmodding its external target', () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)
    fileSystem.add(externalTargetPath, { kind: 'directory', uid: currentUid, mode: 0o755 })
    fileSystem.onBeforeDescriptorChmod = (path) => {
      if (path === profileRootPath) fileSystem.replaceWithSymlink(path, externalTargetPath)
    }

    expect(() => admitPackagedIsolatedProfileRootSync(admissionInput(fileSystem))).toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.externalTargetChmodCalls).toEqual([])
    expect(fileSystem.entries.get(externalTargetPath)?.mode).toBe(0o755)
  })

  it('rejects a leaf swapped after leaf admission during final async identity validation', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)
    fileSystem.add(externalTargetPath, { kind: 'directory', uid: currentUid, mode: 0o755 })
    let swapAfterNextLeafLstat = false
    fileSystem.onBeforeDescriptorChmod = (path) => {
      if (path === profileRootPath) swapAfterNextLeafLstat = true
    }
    fileSystem.onAfterLstat = (path) => {
      if (path === profileRootPath && swapAfterNextLeafLstat) {
        swapAfterNextLeafLstat = false
        fileSystem.replaceWithSymlink(path, externalTargetPath)
      }
    }

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.entries.get(profileRootPath)?.kind).toBe('symlink')
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.entries.get(externalTargetPath)?.mode).toBe(0o755)
  })

  it('rejects the synchronous leaf swap after admission at the final boundary', () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)
    fileSystem.add(externalTargetPath, { kind: 'directory', uid: currentUid, mode: 0o755 })
    let swapAfterNextLeafLstat = false
    fileSystem.onBeforeDescriptorChmod = (path) => {
      if (path === profileRootPath) swapAfterNextLeafLstat = true
    }
    fileSystem.onAfterLstat = (path) => {
      if (path === profileRootPath && swapAfterNextLeafLstat) {
        swapAfterNextLeafLstat = false
        fileSystem.replaceWithSymlink(path, externalTargetPath)
      }
    }

    expect(() => admitPackagedIsolatedProfileRootSync(admissionInput(fileSystem))).toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.entries.get(profileRootPath)?.kind).toBe('symlink')
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.entries.get(externalTargetPath)?.mode).toBe(0o755)
  })

  it('revalidates the parent identity at the final boundary after leaf admission', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(fileSystem, 0o755)
    fileSystem.add(externalTargetPath, { kind: 'directory', uid: currentUid, mode: 0o755 })
    let swapParentAfterLeafAdmission = false
    fileSystem.onBeforeDescriptorChmod = (path) => {
      if (path === profileRootPath) swapParentAfterLeafAdmission = true
    }
    fileSystem.onAfterLstat = (path) => {
      if (path === profileRootPath && swapParentAfterLeafAdmission) {
        swapParentAfterLeafAdmission = false
        fileSystem.replaceWithSymlink(profileParentPath, externalTargetPath)
      }
    }

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.entries.get(profileParentPath)?.kind).toBe('symlink')
    expect(fileSystem.pathChmodCalls).toEqual([])
    expect(fileSystem.externalTargetChmodCalls).toEqual([])
    expect(fileSystem.entries.get(externalTargetPath)?.mode).toBe(0o755)
  })

  it('fails closed on descriptor chmod and lstat failures without admitting a profile', async () => {
    const chmodFailure = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(chmodFailure, 0o755)
    chmodFailure.failDescriptorChmod(profileRootPath)

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(chmodFailure))).rejects.toThrow(
      'Unable to secure packaged isolated profile directory.'
    )
    expect(chmodFailure.pathChmodCalls).toEqual([])

    const lstatFailure = new FakeProfileFileSystem(currentUid)
    lstatFailure.failNextLstat(profileParentPath)
    await expect(admitPackagedIsolatedProfileRoot(admissionInput(lstatFailure))).rejects.toThrow(
      'Unable to inspect packaged isolated profile directory.'
    )
    expect(lstatFailure.entries.has(profileRootPath)).toBe(false)
  })

  it('fails closed on synchronous descriptor chmod and lstat failures', () => {
    const chmodFailure = new FakeProfileFileSystem(currentUid)
    addExistingDirectories(chmodFailure, 0o755)
    chmodFailure.failDescriptorChmod(profileRootPath)

    expect(() => admitPackagedIsolatedProfileRootSync(admissionInput(chmodFailure))).toThrow(
      'Unable to secure packaged isolated profile directory.'
    )
    expect(chmodFailure.pathChmodCalls).toEqual([])

    const lstatFailure = new FakeProfileFileSystem(currentUid)
    lstatFailure.failNextLstat(profileParentPath)
    expect(() => admitPackagedIsolatedProfileRootSync(admissionInput(lstatFailure))).toThrow(
      'Unable to inspect packaged isolated profile directory.'
    )
    expect(lstatFailure.entries.has(profileRootPath)).toBe(false)
  })

  it('fails closed when stable directory identity cannot be established', async () => {
    const fileSystem = new FakeProfileFileSystem(currentUid)
    fileSystem.omitIdentity = true

    await expect(admitPackagedIsolatedProfileRoot(admissionInput(fileSystem))).rejects.toThrow(
      'Packaged isolated profile directory admission was rejected.'
    )
    expect(fileSystem.entries.has(profileRootPath)).toBe(false)
  })
})
