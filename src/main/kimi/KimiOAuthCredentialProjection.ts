// Kimi Code already serializes OAuth refreshes across processes that share a
// KIMI_CODE_HOME: its token storage and short-lived refresh lock live in the
// credentials/ and oauth/ directories respectively. TaskWraith cannot point
// every seat at the user's whole home because that would also import user config,
// plugins, skills, and session history. Instead, each contained seat keeps its
// own home and projects only those two OAuth directories from the real Kimi
// home. The provider's own per-refresh coordination then works for multiple
// TaskWraith seats and ordinary terminal Kimi processes, while each seat retains
// its isolated config and session state.

import { constants, promises as fs } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface KimiOAuthCredentialProjectionRequest {
  /** The real Kimi Code home containing the user's current OAuth login. */
  sourceHome: string
  /** TaskWraith-owned per-seat KIMI_CODE_HOME. */
  isolatedHome: string
  /** TaskWraith-owned private root that contains the seat home. */
  boundaryRoot: string
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right
}

async function assertPrivateDirectory(path: string, label: string): Promise<string> {
  const stat = await fs.lstat(path)
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory.`)
  }
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user.`)
  }
  await fs.chmod(path, PRIVATE_DIRECTORY_MODE)
  const tightened = await fs.lstat(path)
  if (
    tightened.isSymbolicLink() ||
    (process.platform !== 'win32' && (tightened.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} could not be made private.`)
  }
  return fs.realpath(path)
}

async function ensurePrivateDirectory(path: string, label: string): Promise<string> {
  await fs.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  return assertPrivateDirectory(path, label)
}

async function assertPrivateRegularFile(
  root: string,
  path: string,
  label: string
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }

  try {
    const [rootReal, parentReal, opened, pathStat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(join(path, '..')),
      handle.stat(),
      fs.lstat(path)
    ])
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (!pathIsWithin(rootReal, parentReal)) {
      throw new Error(`${label} escaped the Kimi Code home.`)
    }
    if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error(`${label} changed identity while opening.`)
    }
    if (!opened.isFile() || pathStat.isSymbolicLink() || opened.nlink !== 1) {
      throw new Error(`${label} is not a private regular file.`)
    }
    if (currentUid !== undefined && opened.uid !== currentUid) {
      throw new Error(`${label} is not owned by the current user.`)
    }
    if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
      await handle.chmod(PRIVATE_FILE_MODE)
      const tightened = await handle.stat()
      if ((tightened.mode & 0o077) !== 0) {
        throw new Error(`${label} could not be made private.`)
      }
    }
    return true
  } finally {
    await handle.close()
  }
}

async function removeIsolatedEntry(path: string): Promise<void> {
  const stat = await fs.lstat(path).catch((error) => {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  })
  if (!stat) return
  if (stat.isSymbolicLink() || stat.isFile()) {
    await fs.unlink(path)
    return
  }
  await fs.rm(path, { recursive: true, force: true })
}

async function linkSharedDirectory(input: {
  source: string
  isolatedHome: string
  name: 'credentials' | 'oauth'
}): Promise<void> {
  const destination = join(input.isolatedHome, input.name)
  await removeIsolatedEntry(destination)
  await fs.symlink(input.source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  const [stat, resolved] = await Promise.all([fs.lstat(destination), fs.realpath(destination)])
  const isExpectedLink =
    stat.isSymbolicLink() || (process.platform === 'win32' && stat.isDirectory())
  if (!isExpectedLink || !samePath(resolved, input.source)) {
    throw new Error(`Kimi OAuth ${input.name} projection did not resolve to its verified source.`)
  }
}

async function copyOptionalPrivateDeviceId(input: {
  sourceHome: string
  isolatedHome: string
}): Promise<void> {
  const source = join(input.sourceHome, 'device_id')
  const destination = join(input.isolatedHome, 'device_id')
  await removeIsolatedEntry(destination)
  if (!(await assertPrivateRegularFile(input.sourceHome, source, 'Kimi device identity'))) return
  await fs.copyFile(source, destination)
  await fs.chmod(destination, PRIVATE_FILE_MODE)
  const copied = await fs.lstat(destination)
  if (
    !copied.isFile() ||
    copied.isSymbolicLink() ||
    copied.nlink !== 1 ||
    (process.platform !== 'win32' && (copied.mode & 0o077) !== 0)
  ) {
    throw new Error('Kimi device identity projection is not a private regular file.')
  }
}

/**
 * Project Kimi's token storage and its upstream refresh-lock directory into a
 * TaskWraith-owned isolated seat home. The links are removed by the ordinary
 * isolated-home cleanup; this function never removes or copies a credential
 * from the real Kimi home.
 */
export async function prepareKimiOAuthCredentialProjection(
  input: KimiOAuthCredentialProjectionRequest
): Promise<void> {
  try {
    const sourceHome = await fs.realpath(input.sourceHome)
    const sourceStat = await fs.stat(sourceHome)
    if (!sourceStat.isDirectory()) throw new Error('The Kimi Code home is not a directory.')

    const [boundaryRoot, isolatedHome] = await Promise.all([
      assertPrivateDirectory(input.boundaryRoot, 'TaskWraith Kimi home boundary'),
      assertPrivateDirectory(input.isolatedHome, 'TaskWraith Kimi seat home')
    ])
    if (!pathIsWithin(boundaryRoot, isolatedHome)) {
      throw new Error('The Kimi seat home escaped its TaskWraith boundary.')
    }
    if (pathIsWithin(sourceHome, isolatedHome) || pathIsWithin(isolatedHome, sourceHome)) {
      throw new Error('The real Kimi Code home and TaskWraith seat home overlap.')
    }

    const [credentials, oauth] = await Promise.all([
      assertPrivateDirectory(join(sourceHome, 'credentials'), 'Kimi credential directory'),
      ensurePrivateDirectory(join(sourceHome, 'oauth'), 'Kimi OAuth lock directory')
    ])
    const credential = join(credentials, 'kimi-code.json')
    if (!(await assertPrivateRegularFile(sourceHome, credential, 'Kimi OAuth credential'))) {
      throw new Error('The current Kimi OAuth credential is unavailable.')
    }

    await Promise.all([
      linkSharedDirectory({ source: credentials, isolatedHome, name: 'credentials' }),
      linkSharedDirectory({ source: oauth, isolatedHome, name: 'oauth' })
    ])
    await copyOptionalPrivateDeviceId({ sourceHome, isolatedHome })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not prepare shared Kimi OAuth credentials: ${detail}`)
  }
}
