import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type { SharedWorkspaceVerification } from '../../shared/sharedWorkspace'
import { readScopedRegularFile } from '../ScopedPathAccess'
import { resolveGitCommonDirectory } from '../workLocks/WorkspaceMarkerGitExclude'
import { journalGit } from './SharedWorkspaceContributions'
import { sharedWorkspaceFileVersion, withSharedWorkspaceOperation } from './SharedWorkspaceSession'

interface Inputs {
  fingerprint: string
  paths: Set<string>
}
const inFlight = new Map<string, Promise<Inputs | null>>()
const MAX_FILES = 10000
const MAX_BYTES = 128 * 1024 * 1024
const SAMPLE_DEADLINE_MS = 2000

/** These are observed live-checkout checks, not immutable build attestations or release authority. */
export async function beginSharedWorkspaceVerification(
  root: string,
  command: readonly string[]
): Promise<{
  finish: (result: {
    exitCode: number | null
    timedOut?: boolean
    error?: string
  }) => Promise<SharedWorkspaceVerification | null>
} | null> {
  const directory = receiptDirectory(root)
  if (!directory) return null
  const startedAt = new Date().toISOString()
  const changed = new Set<string>()
  let observationFailed = false
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) {
        observationFailed = true
        return
      }
      const path = filename.toString().split(sep).join('/')
      if (path === '.git' || path.startsWith('.git/') || path.startsWith('.WORK-IN-PROGRESS-'))
        return
      if (changed.size >= MAX_FILES) observationFailed = true
      else changed.add(path)
    })
    watcher.on('error', () => {
      observationFailed = true
    })
    watcher.unref()
  } catch {
    observationFailed = true
  }
  const before = await sampleInputs(root)
  return {
    finish: async (result) => {
      try {
        const after = await sampleInputs(root)
        // Let already-queued watcher notifications settle before closing the observation window.
        await new Promise<void>((resolveTick) => setImmediate(resolveTick))
        const touchedInput =
          before &&
          [...changed].some(
            (path) =>
              before.paths.has(path) ||
              [...before.paths].some((input) => input.startsWith(`${path}/`))
          )
        const state: SharedWorkspaceVerification['state'] =
          result.exitCode !== 0 || result.timedOut || result.error
            ? 'failed'
            : !before || !after || observationFailed
              ? 'unavailable'
              : before.fingerprint !== after.fingerprint || touchedInput
                ? 'changed'
                : 'passed'
        const receipt: SharedWorkspaceVerification = {
          id: randomUUID(),
          command: command.join(' '),
          startedAt,
          finishedAt: new Date().toISOString(),
          state,
          fingerprint: before?.fingerprint || null,
          reason:
            state === 'passed'
              ? 'Observed tracked and nonignored inputs were unchanged. This check ran in the live checkout.'
              : state === 'changed'
                ? 'Workspace inputs changed during this check; rerun against the current state.'
                : state === 'unavailable'
                  ? 'The input snapshot or change observation was incomplete. The command result remains available.'
                  : 'The check did not complete successfully.'
        }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const filename = `${Date.parse(receipt.finishedAt)}-${receipt.id}.json`
        const temporary = join(directory, `${filename}.tmp`)
        await fs.writeFile(temporary, JSON.stringify(receipt), {
          flag: 'wx',
          mode: 0o600
        })
        await fs.rename(temporary, join(directory, filename))
        const old = (await fs.readdir(directory))
          .filter((name) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name))
          .sort()
          .slice(0, -200)
        await Promise.all(old.map((name) => fs.rm(join(directory, name), { force: true })))
        return receipt
      } catch {
        return null
      } finally {
        watcher?.close()
      }
    }
  }
}

export async function latestSharedWorkspaceVerification(
  root: string
): Promise<SharedWorkspaceVerification | null> {
  const directory = receiptDirectory(root)
  if (!directory) return null
  const names = (await fs.readdir(directory).catch(() => []))
    .filter((name) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name))
    .sort()
    .slice(-1)
  // Read bounded metadata only; files and lock authority are never changed by this query.
  const receipts: SharedWorkspaceVerification[] = []
  for (const name of names.slice(-200)) {
    try {
      const path = join(directory, name)
      const stat = await fs.lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw new Error('Invalid check receipt.')
      const value = JSON.parse(await fs.readFile(path, 'utf8')) as SharedWorkspaceVerification
      if (
        typeof value.command !== 'string' ||
        typeof value.finishedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.finishedAt)) ||
        !['passed', 'failed', 'changed', 'unavailable'].includes(value.state)
      )
        throw new Error('Invalid check receipt.')
      receipts.push(value)
    } catch {
      return {
        id: name,
        command: 'Recorded check',
        startedAt: '',
        finishedAt: '',
        state: 'unavailable',
        fingerprint: null,
        reason: 'The latest check receipt is unreadable.'
      }
    }
  }
  receipts.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  const latest = receipts[0]
  if (!latest || latest.state !== 'passed') return latest || null
  const current = await sampleInputs(root)
  if (!current)
    return {
      ...latest,
      state: 'unavailable',
      reason: 'Current input freshness could not be verified.'
    }
  if (current.fingerprint !== latest.fingerprint)
    return {
      ...latest,
      state: 'changed',
      reason: 'Workspace inputs changed after this check passed.'
    }
  return latest
}

function sampleInputs(root: string): Promise<Inputs | null> {
  const key = resolve(root)
  const existing = inFlight.get(key)
  if (existing) return existing
  const pending = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      return await Promise.race([
        captureInputs(key, controller.signal).catch(() => null),
        new Promise<null>((resolveTimeout) => {
          timer = setTimeout(() => {
            controller.abort()
            resolveTimeout(null)
          }, SAMPLE_DEADLINE_MS)
          timer.unref?.()
        })
      ])
    } finally {
      clearTimeout(timer)
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, pending)
  return pending
}

async function captureInputs(root: string, signal: AbortSignal): Promise<Inputs> {
  const deadline = Date.now() + SAMPLE_DEADLINE_MS
  const listing = await journalGit(
    root,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    undefined,
    {},
    signal
  )
  const paths = [
    ...new Set(listing.split('\0').filter((path) => path && !path.startsWith('.WORK-IN-PROGRESS-')))
  ].sort()
  if (paths.length > MAX_FILES) throw new Error('Input snapshot exceeded its file budget.')
  const values = new Array<string>(paths.length)
  let bytes = 0
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(12, paths.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= paths.length) return
        if (Date.now() > deadline || signal.aborted)
          throw new Error('Input snapshot exceeded its time budget.')
        const path = paths[index]
        const targetPath = resolve(root, path)
        const stat = await fs.lstat(targetPath, { bigint: true }).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (!stat) {
          values[index] = JSON.stringify([path, 'missing'])
          continue
        }
        if (!stat.isFile()) throw new Error('Input snapshot contains a non-regular input.')
        bytes += Number(stat.size)
        if (bytes > MAX_BYTES) throw new Error('Input snapshot exceeded its byte budget.')
        const { buffer } = await withSharedWorkspaceOperation(() =>
          readScopedRegularFile({ rootPath: root, targetPath }, { maxBytes: 20 * 1024 * 1024 })
        )
        const after = await fs.lstat(targetPath, { bigint: true })
        if (sharedWorkspaceFileVersion(stat) !== sharedWorkspaceFileVersion(after))
          throw new Error('Input changed while sampled.')
        values[index] = JSON.stringify([
          path,
          String(stat.mode),
          createHash('sha256').update(buffer).digest('hex')
        ])
      }
    })
  )
  const head = (await journalGit(root, ['rev-parse', 'HEAD'], undefined, {}, signal)).trim()
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify([head, process.version, process.platform, values]))
      .digest('hex'),
    paths: new Set(paths)
  }
}

function receiptDirectory(root: string): string | null {
  const common = resolveGitCommonDirectory(root)
  return common
    ? join(
        common,
        'taskwraith',
        'shared-verification-v1',
        createHash('sha256').update(resolve(root)).digest('hex')
      )
    : null
}
