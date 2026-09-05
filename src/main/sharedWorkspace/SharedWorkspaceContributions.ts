import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { devNull } from 'node:os'

import type {
  SharedWorkspaceContribution,
  SharedWorkspaceContributionPreview
} from '../../shared/sharedWorkspace'
import { resolveGitCommonDirectory } from '../workLocks/WorkspaceMarkerGitExclude'
import {
  currentSharedWorkspaceActor,
  currentSharedWorkspaceTool,
  withSharedWorkspaceOperation,
  type SharedWorkspaceActor
} from './SharedWorkspaceSession'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_RECORDS = 2000
const LEASE_MS = 20 * 60 * 1000
const HASH = /^[a-f0-9]{64}$/
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const ID = /^[a-f0-9-]{36}$/
const MARKER_PREFIX = '.WORK-IN-PROGRESS-taskwraith-contribution-'
const intentActivity = new Map<string, number>()

interface JournalRoot {
  root: string
  directory: string
  worktreeId: string
  commonDir: string
}
interface Version {
  blob: string
  hash: string
  mode: '100644' | '100755'
}
interface EditRecord {
  schemaVersion: 1
  id: string
  contributionId: string
  actor: SharedWorkspaceActor
  path: string
  before: Version | null
  after: Version
  createdAt: string
}
interface JournalEntry {
  record: EditRecord
  state: 'prepared' | 'applied' | 'settled' | 'aborted'
}

export interface SharedWorkspaceEditReceipt {
  intentClaim: boolean
  complete(): Promise<boolean>
  abort(): Promise<void>
}

export async function touchSharedWorkspaceIntent(root: string): Promise<void> {
  const actor = currentSharedWorkspaceActor()
  if (!actor?.lockOwnerId) return
  const key = `${root}:${actor.lockOwnerId}`
  if (Date.now() - (intentActivity.get(key) || 0) < 60_000) return
  intentActivity.set(key, Date.now())
  if (intentActivity.size > 512) intentActivity.delete(intentActivity.keys().next().value!)
  await boundedCapture(
    (async () => {
      const journal = await journalRoot(root)
      if (journal) await refreshMarker(journal, digest(actor.key), actor)
    })()
  )
}

/** Recovery snapshots are Git objects under local refs. They are separate from authority-free provenance metadata. */
export async function prepareSharedWorkspaceEdit(
  authority: { rootPath: string; targetPath: string },
  before: Buffer | null,
  after: Buffer,
  executable: boolean
): Promise<SharedWorkspaceEditReceipt | null> {
  return boundedCapture(prepareEdit(authority, before, after, executable))
}

async function prepareEdit(
  authority: { rootPath: string; targetPath: string },
  before: Buffer | null,
  after: Buffer,
  executable: boolean
): Promise<SharedWorkspaceEditReceipt | null> {
  const actor = currentSharedWorkspaceActor()
  if (!actor || !['write_file', 'replace'].includes(currentSharedWorkspaceTool() || '')) return null
  if (after.length > MAX_BYTES || (before && before.length > MAX_BYTES) || before?.equals(after))
    return null
  // Bookkeeping never keeps a mutation lock while waiting indefinitely for audit I/O.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  timeout.unref?.()
  try {
    const journal = await journalRoot(authority.rootPath)
    if (!journal || controller.signal.aborted) return null
    const path = relativePath(journal.root, authority.targetPath)
    try {
      await journalGit(
        journal.root,
        ['check-ignore', '-q', '--', path],
        undefined,
        {},
        controller.signal
      )
      return null
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode !== 1) throw error
    }
    await fs.mkdir(join(journal.directory, digest(actor.key)), { recursive: true, mode: 0o700 })
    const mode = executable ? ('100755' as const) : ('100644' as const)
    const version = async (buffer: Buffer): Promise<Version> => ({
      blob: (
        await journalGit(
          journal.root,
          ['hash-object', '-w', '--stdin'],
          buffer,
          {},
          controller.signal
        )
      ).trim(),
      hash: digest(buffer),
      mode
    })
    const record: EditRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      contributionId: digest(actor.key),
      actor: { ...actor },
      path,
      before: before ? await version(before) : null,
      after: await version(after),
      createdAt: new Date().toISOString()
    }
    const treeInput = [
      record.before ? `100644 blob ${record.before.blob}\tbefore\0` : '',
      `100644 blob ${record.after.blob}\tafter\0`
    ].join('')
    const tree = (
      await journalGit(journal.root, ['mktree', '-z'], treeInput, {}, controller.signal)
    ).trim()
    await journalGit(
      journal.root,
      ['update-ref', snapshotRef(journal, record), tree],
      undefined,
      {},
      controller.signal
    )
    await fs.writeFile(
      join(journal.directory, `${record.contributionId}.${record.id}.active`),
      '',
      { flag: 'wx', mode: 0o600 }
    )
    await atomicJson(
      join(journal.directory, record.contributionId, `${record.id}.prepared.json`),
      record
    )
    await refreshMarker(journal, record.contributionId, actor)
    const marker = await fs
      .readFile(join(journal.root, `${MARKER_PREFIX}${record.contributionId}.md`), 'utf8')
      .catch(() => '')
    return {
      intentClaim:
        !/[\r\n]/.test(path) &&
        marker.includes(`\n  - ${path}\n`) &&
        marker.includes(`\nlockOwnerId: ${actor.lockOwnerId}\n`),
      complete: async () => {
        return (await boundedCapture(settleCapture(journal, record, 'applied'))) ?? false
      },
      abort: async () => {
        await boundedCapture(settleCapture(journal, record, 'aborted'))
      }
    }
  } catch {
    // Missing capture is not write authority. Existing approval and lock decisions remain intact.
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function settleCapture(
  journal: JournalRoot,
  record: EditRecord,
  state: 'applied' | 'aborted'
): Promise<boolean> {
  try {
    await atomicJson(join(journal.directory, record.contributionId, `${record.id}.${state}.json`), {
      id: record.id,
      at: new Date().toISOString()
    })
    if (state === 'aborted')
      await fs.rm(join(journal.directory, `${record.contributionId}.${record.id}.active`), {
        force: true
      })
    if (state === 'aborted') {
      await journalGit(journal.root, ['update-ref', '-d', snapshotRef(journal, record)]).catch(
        () => {}
      )
      await refreshMarker(journal, record.contributionId, record.actor)
    }
    return true
  } catch {
    /* Receipt failure must not turn a completed edit into a failed edit. */
    return false
  }
}

export async function listSharedWorkspaceContributions(
  root: string
): Promise<{ contributions: SharedWorkspaceContribution[]; truncated: boolean }> {
  const journal = await journalRoot(root)
  if (!journal) return { contributions: [], truncated: false }
  const { entries, truncated } = await readEntries(journal)
  const ids = [
    ...new Set(
      entries
        .filter((e) => e.state === 'applied' || e.state === 'prepared')
        .map((e) => e.record.contributionId)
    )
  ]
  const contributions: SharedWorkspaceContribution[] = []
  for (const id of ids) {
    const detail = await contribution(journal, entries, id, false)
    if (detail) {
      const { patch: _patch, reversePatch: _reverse, recordIds: _ids, ...summary } = detail
      contributions.push(summary)
    }
  }
  return { contributions, truncated }
}

export async function previewSharedWorkspaceContribution(
  root: string,
  id: string
): Promise<SharedWorkspaceContributionPreview> {
  if (!HASH.test(id)) throw new Error('Invalid contribution ID.')
  const journal = await journalRoot(root)
  if (!journal) throw new Error('Contribution recovery requires a Git repository.')
  const { entries, truncated } = await readEntries(journal, id)
  if (truncated)
    throw new Error(
      'The contribution window is incomplete; review the recorded edits individually.'
    )
  const result = await contribution(journal, entries, id, true)
  if (!result) throw new Error('This contribution has already settled or has no captured edits.')
  return result
}

export async function prepareCurrentContribution(
  root: string,
  paths: readonly string[]
): Promise<SharedWorkspaceContributionPreview> {
  const actor = currentSharedWorkspaceActor()
  if (!actor)
    throw new Error(
      'This execution route has no captured contribution identity; supply an explicit private-index patch.'
    )
  const journal = await journalRoot(root)
  if (!journal) throw new Error('Contribution commits require a Git repository.')
  await refreshMarker(journal, digest(actor.key), actor)
  const result = await previewSharedWorkspaceContribution(root, digest(actor.key))
  const declared = [
    ...new Set(paths.map((p) => relativePath(journal.root, resolve(root, p))))
  ].sort()
  if (JSON.stringify(declared) !== JSON.stringify([...result.paths].sort())) {
    throw new Error(
      'Contribution mode requires its exact captured file set. Use private_index with an explicit patch for a subset.'
    )
  }
  if (result.state !== 'ready')
    throw new Error(result.reason || 'Contribution changed; review it before committing.')
  return result
}

export async function settleSharedWorkspaceContribution(
  root: string,
  preview: SharedWorkspaceContributionPreview,
  outcome: 'committed' | 'undone'
): Promise<void> {
  const journal = await journalRoot(root)
  if (!journal) return
  for (const id of preview.recordIds) {
    if (!ID.test(id)) throw new Error('Invalid contribution record.')
    await atomicJson(join(journal.directory, preview.id, `${id}.settled.json`), {
      id,
      outcome,
      at: new Date().toISOString()
    })
    await fs.rm(join(journal.directory, `${preview.id}.${id}.active`), { force: true })
    // Settled work no longer needs a recovery pin; Git retains reachable
    // committed objects and reclaims unreferenced snapshots under its normal GC policy.
    await journalGit(journal.root, [
      'update-ref',
      '-d',
      `refs/taskwraith/contributions/${journal.worktreeId}/${id}`
    ]).catch(() => {})
  }
  await refreshMarker(journal, preview.id)
}

/** The user has reviewed this exact contribution; durable mutation locks must already be held. */
export async function suspendSharedWorkspaceIntent(
  root: string,
  id: string
): Promise<() => Promise<void>> {
  if (!HASH.test(id)) throw new Error('Invalid contribution ID.')
  const journal = await journalRoot(root)
  if (!journal) throw new Error('Contribution repository disappeared.')
  const marker = join(journal.root, `${MARKER_PREFIX}${id}.md`)
  const contents = await fs.readFile(marker, 'utf8').catch(() => null)
  if (contents !== null) await fs.unlink(marker)
  return async () => {
    if (contents !== null)
      await fs.writeFile(marker, contents, { flag: 'wx', mode: 0o600 }).catch(() => {})
  }
}

export async function confirmRecoveredContribution(
  root: string,
  preview: SharedWorkspaceContributionPreview
): Promise<void> {
  const journal = await journalRoot(root)
  if (!journal || !HASH.test(preview.id)) throw new Error('Contribution repository disappeared.')
  for (const id of preview.recordIds) {
    if (!ID.test(id)) throw new Error('Invalid contribution record.')
    await atomicJson(join(journal.directory, preview.id, `${id}.applied.json`), {
      id,
      recoveredAt: new Date().toISOString()
    })
  }
  await refreshMarker(journal, preview.id)
}

async function contribution(
  journal: JournalRoot,
  entries: JournalEntry[],
  id: string,
  includePatch: boolean
): Promise<SharedWorkspaceContributionPreview | null> {
  const selected = entries.filter(
    (e) => e.record.contributionId === id && (e.state === 'prepared' || e.state === 'applied')
  )
  if (!selected.length) return null
  selected.sort(
    (a, b) =>
      a.record.createdAt.localeCompare(b.record.createdAt) || a.record.id.localeCompare(b.record.id)
  )
  const files = new Map<string, { before: Version | null; after: Version }>()
  let continuous = true
  let state: SharedWorkspaceContribution['state'] = selected.some((e) => e.state === 'prepared')
    ? 'interrupted'
    : 'ready'
  let reason =
    state === 'interrupted'
      ? 'An edit was prepared but its completion was not recorded. Review the recovery patch.'
      : undefined
  const currentHashes: Array<[string, string | null]> = []
  for (const { record } of selected) {
    const previous = files.get(record.path)
    if (previous && previous.after.hash !== record.before?.hash) {
      continuous = false
      state = 'changed'
      reason =
        'Another change intervened between this task’s edits to the same file. Review the individual snapshots.'
    }
    files.set(record.path, {
      before: previous ? previous.before : record.before,
      after: record.after
    })
  }
  for (const [path, version] of files) {
    const current = await currentFileHash(journal.root, path, version.after.mode)
    currentHashes.push([path, current])
    if (
      current !== version.after.hash &&
      !(state === 'interrupted' && current === (version.before?.hash ?? null))
    ) {
      state = 'changed'
      reason =
        'Current file state changed after this contribution or could not be read. Review before committing or undoing.'
    }
  }
  const recordIds = selected.map((e) => e.record.id)
  const actor = selected[selected.length - 1].record.actor
  let patch = ''
  let reversePatch = ''
  if (includePatch && continuous) {
    const beforeTree = await contributionTree(journal, files, 'before')
    const afterTree = await contributionTree(journal, files, 'after')
    patch = await journalGit(journal.root, [
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      beforeTree,
      afterTree,
      '--'
    ])
    reversePatch = await journalGit(journal.root, [
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      afterTree,
      beforeTree,
      '--'
    ])
  }
  return {
    id,
    // Bind reviewed actions to the actual patch and its provenance, not merely
    // record filenames: local evidence can be edited independently of live files.
    generation: digest(JSON.stringify([selected, currentHashes, patch, reversePatch])),
    provider: actor.provider,
    ...(actor.chatId ? { chatId: actor.chatId } : {}),
    ...(actor.participantId ? { participantId: actor.participantId } : {}),
    paths: [...files.keys()],
    editCount: selected.length,
    updatedAt: selected[selected.length - 1].record.createdAt,
    state,
    ...(reason ? { reason } : {}),
    patch,
    reversePatch,
    recordIds
  }
}

async function contributionTree(
  journal: JournalRoot,
  files: Map<string, { before: Version | null; after: Version }>,
  side: 'before' | 'after'
): Promise<string> {
  const index = join(journal.directory, `index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    await journalGit(journal.root, ['read-tree', '--empty'], undefined, env)
    const input = [...files]
      .flatMap(([path, versions]) => {
        const version = versions[side]
        return version ? [`${version.mode} ${version.blob}\t${path}\0`] : []
      })
      .join('')
    if (input) await journalGit(journal.root, ['update-index', '-z', '--index-info'], input, env)
    return (await journalGit(journal.root, ['write-tree'], undefined, env)).trim()
  } finally {
    await fs.rm(index, { force: true })
  }
}

async function currentFileHash(
  root: string,
  path: string,
  expectedMode?: Version['mode']
): Promise<string | null> {
  try {
    const { readScopedRegularFile } = await import('../ScopedPathAccess')
    const { buffer, stat } = await withSharedWorkspaceOperation(() =>
      readScopedRegularFile(
        { rootPath: root, targetPath: resolve(root, path) },
        { maxBytes: MAX_BYTES }
      )
    )
    if (expectedMode && ((stat.mode & 0o111n) !== 0n) !== (expectedMode === '100755'))
      return 'unavailable'
    return digest(buffer)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unavailable'
  }
}

async function refreshMarker(
  journal: JournalRoot,
  id: string,
  actorOverride?: SharedWorkspaceActor
): Promise<void> {
  const directory = join(journal.directory, id)
  const beforeScan = await directoryVersion(directory)
  const { entries, truncated } = await readEntries(journal, id)
  if (truncated) return
  const pending = entries.filter(
    (e) => e.record.contributionId === id && (e.state === 'prepared' || e.state === 'applied')
  )
  const marker = join(journal.root, `${MARKER_PREFIX}${id}.md`)
  if (!pending.length) {
    await fs.rm(marker, { force: true })
    if (beforeScan && beforeScan === (await directoryVersion(directory))) {
      await atomicJson(join(journal.directory, `${id}.closed.json`), {
        schemaVersion: 1,
        directoryVersion: beforeScan
      })
    }
    return
  }
  const actor = actorOverride || pending[pending.length - 1].record.actor
  if (!actor.lockOwnerId || /[\r\n\0]/.test(actor.lockOwnerId)) return
  // Exact owner identity comes from admission, never a provider-supplied tool argument.
  const latest = new Map<string, JournalEntry>()
  for (const entry of [...pending].sort((a, b) =>
    a.record.createdAt.localeCompare(b.record.createdAt)
  ))
    latest.set(entry.record.path, entry)
  const paths: string[] = []
  for (const [path, entry] of latest) {
    const current = await currentFileHash(journal.root, path, entry.record.after.mode)
    if (
      current === entry.record.after.hash ||
      (entry.state === 'prepared' && current === (entry.record.before?.hash ?? null))
    )
      paths.push(path)
  }
  if (!paths.length) {
    await fs.rm(marker, { force: true })
    return
  }
  if (paths.some((p) => /[\r\n]/.test(p) || p.trim() !== p)) return // Keep byte-sensitive names in the journal, not lossy YAML.
  if (
    [actor.chatId, actor.runId, actor.lockOwnerId].some(
      (v) => v && (v.length > 512 || /[\r\n\0]/.test(v))
    )
  )
    return
  const now = new Date()
  const excluded = join(journal.commonDir, 'info', 'exclude')
  await fs.mkdir(dirname(excluded), { recursive: true })
  const pattern = `${MARKER_PREFIX}*.md`
  const existing = await fs.readFile(excluded, 'utf8').catch(() => '')
  if (!existing.split('\n').includes(pattern)) await fs.appendFile(excluded, `\n${pattern}\n`)
  const text = [
    '---',
    `session: ${id}`,
    'agent: taskwraith-contribution',
    `taskId: ${actor.chatId || actor.runId}`,
    `lockOwnerId: ${actor.lockOwnerId}`,
    `started: ${now.toISOString()}`,
    `expires: ${new Date(now.getTime() + LEASE_MS).toISOString()}`,
    'paths:',
    ...paths.map((p) => `  - ${p}`),
    '---',
    'Host-maintained intent claim for captured edits. Actual write authority remains in the runtime lock service.',
    ''
  ].join('\n')
  await atomicText(marker, text)
}

async function journalRoot(root: string): Promise<JournalRoot | null> {
  try {
    const canonical = await fs.realpath(resolve(root))
    const entry = await fs.lstat(join(canonical, '.git')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!entry) return null
    const common = resolveGitCommonDirectory(canonical)
    if (!common) throw new Error('Git metadata could not be resolved for contribution evidence.')
    const commonDir = await fs.realpath(common)
    const worktreeId = digest(canonical)
    const directory = join(commonDir, 'taskwraith', 'shared-workspace-v1', worktreeId)
    return { root: canonical, directory, worktreeId, commonDir }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readEntries(
  journal: JournalRoot,
  onlyId?: string
): Promise<{ entries: JournalEntry[]; truncated: boolean }> {
  const rootNames = await readDirectory(journal.directory)
  const activeRecords = rootNames.filter((name) =>
    /^[a-f0-9]{64}\.[a-f0-9-]{36}\.active$/.test(name)
  )
  const activeActors = new Set(activeRecords.map((name) => name.slice(0, 64)))
  const directories = onlyId ? [onlyId] : rootNames.filter((n) => HASH.test(n))
  const entries: JournalEntry[] = []
  let incomplete = false
  let activeDirectories = 0
  for (const contributionId of directories) {
    const directory = join(journal.directory, contributionId)
    const version = await directoryVersion(directory)
    const closed = join(journal.directory, `${contributionId}.closed.json`)
    try {
      const stat = await fs.lstat(closed)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 2048) {
        const summary = JSON.parse(await fs.readFile(closed, 'utf8'))
        if (
          !activeActors.has(contributionId) &&
          version &&
          summary.schemaVersion === 1 &&
          summary.directoryVersion === version
        )
          continue
      }
    } catch {
      /* A missing/stale summary cannot hide new work. */
    }
    const names = await readDirectory(directory)
    if (!names.length) continue
    if (++activeDirectories > 256) {
      incomplete = true
      break
    }
    const prepared = names.filter((n) => /^[a-f0-9-]{36}\.prepared\.json$/.test(n)).sort()
    const present = new Set(names)
    if (
      activeRecords.some(
        (name) =>
          name.startsWith(`${contributionId}.`) &&
          !present.has(`${name.slice(65, 101)}.prepared.json`)
      )
    )
      incomplete = true
    if (prepared.length + entries.length > MAX_RECORDS) incomplete = true
    for (const name of prepared.slice(0, Math.max(0, MAX_RECORDS - entries.length))) {
      const path = join(directory, name)
      try {
        const stat = await fs.lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) {
          incomplete = true
          continue
        }
        const record = JSON.parse(await fs.readFile(path, 'utf8')) as EditRecord
        if (
          !validRecord(record) ||
          record.contributionId !== contributionId ||
          name !== `${record.id}.prepared.json`
        ) {
          incomplete = true
          continue
        }
        const state = present.has(`${record.id}.settled.json`)
          ? 'settled'
          : present.has(`${record.id}.aborted.json`)
            ? 'aborted'
            : present.has(`${record.id}.applied.json`)
              ? 'applied'
              : 'prepared'
        entries.push({ record, state })
      } catch {
        incomplete = true
      }
    }
  }
  return { entries, truncated: incomplete }
}

async function directoryVersion(path: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(path, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Contribution storage is not a regular directory.')
    return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function validRecord(value: EditRecord): boolean {
  const version = (v: Version | null): boolean =>
    !!v && OID.test(v.blob) && HASH.test(v.hash) && ['100644', '100755'].includes(v.mode)
  return (
    !!value &&
    value.schemaVersion === 1 &&
    ID.test(value.id) &&
    HASH.test(value.contributionId) &&
    !!value.actor &&
    typeof value.actor.provider === 'string' &&
    typeof value.actor.key === 'string' &&
    digest(value.actor.key) === value.contributionId &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    value.path.length < 4096 &&
    !isAbsolute(value.path) &&
    !value.path.includes('\0') &&
    !value.path.split(/[\\/]/).includes('..') &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (!value.before || version(value.before)) &&
    version(value.after)
  )
}

function relativePath(root: string, path: string): string {
  const value = relative(root, resolve(path)).split(sep).join('/')
  if (!value || isAbsolute(value) || value.split('/').includes('..') || value.includes('\0'))
    throw new Error('Contribution path escapes its workspace.')
  return value
}

function snapshotRef(journal: JournalRoot, record: EditRecord): string {
  return `refs/taskwraith/contributions/${journal.worktreeId}/${record.id}`
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, `${JSON.stringify(value)}\n`)
}
async function atomicText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function boundedCapture<T>(pending: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1500)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Plumbing only: commit publication still uses the normal executor and its configured hooks. */
export function journalGit(
  root: string,
  args: string[],
  input?: string | Buffer,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal
): Promise<string> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT'
      ].includes(key) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
    )
      delete env[key]
  }
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, ...args],
      {
        cwd: root,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
        timeout: 4000,
        maxBuffer: 12 * 1024 * 1024,
        signal
      },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(stderr || error.message), { exitCode: error.code }))
          : resolveResult(stdout)
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
