import fs from 'node:fs'
import path from 'node:path'

import { parseRunEventLine } from '../RunEventStore'
import {
  PROJECT_REFERENCE_OWNERSHIP_LEDGER_MAX_BYTES,
  PROJECT_REFERENCE_OWNERSHIP_MAX_ARTIFACTS,
  PROJECT_REFERENCE_OWNERSHIP_MAX_ID_BYTES,
  PROJECT_REFERENCE_OWNERSHIP_MAX_OWNERS_PER_ARTIFACT
} from './ProjectReferenceArtifactLedger'
import type { ProjectReferenceLegacyArtifactRef } from './ProjectReferenceArtifactStore'
import { projectReferenceOwnedArtifactRefsFromRunEvent } from './ProjectReferenceLegacyOwnership'

export const PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_FILES = 100_000
export const PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_LINE_BYTES = 2 * 1024 * 1024
export const PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_REFERENCES = Math.ceil(
  PROJECT_REFERENCE_OWNERSHIP_LEDGER_MAX_BYTES / 64
)
export const PROJECT_REFERENCE_OWNERSHIP_SCAN_INTEGRITY = 'legacy-parse-only' as const

const REFERENCE_CONTEXT_KIND_NEEDLE = '"kind":"reference_context"'
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface ProjectReferenceOwnershipScanRequest {
  runEventsDirectory: string
}

interface FileIdentity {
  dev: string
  ino: string
}

interface ScanState {
  referencesByOwner: Map<string, ProjectReferenceLegacyArtifactRef>
  ownersPerSha: Map<string, number>
  sha256s: Set<string>
  serializedBytes: number
}

function identity(stat: fs.Stats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function sameFileIdentity(left: fs.Stats | FileIdentity, right: fs.Stats | FileIdentity): boolean {
  return (
    String(left.ino) === String(right.ino) &&
    (process.platform === 'win32' || String(left.dev) === String(right.dev))
  )
}

function isMainOwned(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (
    (uid === null || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0)
  )
}

async function canonicalRunEventsDirectory(
  input: string
): Promise<{ path: string; identity: FileIdentity }> {
  if (!path.isAbsolute(input) || input.includes('\0')) {
    throw new Error('Project-reference run-event directory must be an absolute local path.')
  }
  const requested = path.resolve(input)
  let before: fs.Stats
  try {
    before = await fs.promises.lstat(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('Project-reference run-event directory is missing.')
    }
    throw error
  }
  if (before.isSymbolicLink() || !before.isDirectory() || !isMainOwned(before)) {
    throw new Error('Project-reference run-event directory is unsafe.')
  }
  const canonical = await fs.promises.realpath(requested)
  const after = await fs.promises.stat(canonical)
  if (!after.isDirectory() || !sameFileIdentity(before, after) || !isMainOwned(after)) {
    throw new Error('Project-reference run-event directory identity changed.')
  }
  return { path: canonical, identity: identity(after) }
}

export function isProjectReferenceLegacyArtifactRef(
  value: unknown
): value is ProjectReferenceLegacyArtifactRef {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ProjectReferenceLegacyArtifactRef>
  return (
    typeof candidate.sha256 === 'string' &&
    SHA256_HEX.test(candidate.sha256) &&
    typeof candidate.path === 'string' &&
    path.isAbsolute(candidate.path) &&
    !candidate.path.includes('\0') &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    (candidate.sizeBytes ?? 0) > 0 &&
    typeof candidate.appChatId === 'string' &&
    Boolean(candidate.appChatId) &&
    Buffer.byteLength(candidate.appChatId, 'utf8') <= PROJECT_REFERENCE_OWNERSHIP_MAX_ID_BYTES &&
    typeof candidate.runId === 'string' &&
    Boolean(candidate.runId) &&
    Buffer.byteLength(candidate.runId, 'utf8') <= PROJECT_REFERENCE_OWNERSHIP_MAX_ID_BYTES
  )
}

function ownerKey(reference: ProjectReferenceLegacyArtifactRef): string {
  return JSON.stringify([reference.sha256, reference.appChatId, reference.runId])
}

function emptyScanState(): ScanState {
  // Brackets in the eventual JSON array. Tracking bytes incrementally keeps
  // the utility-process heap and the structured-clone response bounded.
  return {
    referencesByOwner: new Map(),
    ownersPerSha: new Map(),
    sha256s: new Set(),
    serializedBytes: 2
  }
}

function addReference(
  state: ScanState,
  reference: ProjectReferenceLegacyArtifactRef
): 'added' | 'duplicate' {
  if (!isProjectReferenceLegacyArtifactRef(reference)) {
    throw new Error('Project-reference run-event contains an invalid artifact reference.')
  }
  const key = ownerKey(reference)
  const existing = state.referencesByOwner.get(key)
  if (existing) {
    if (existing.path !== reference.path || existing.sizeBytes !== reference.sizeBytes) {
      throw new Error('Project-reference ownership conflicts for the same artifact and owner.')
    }
    return 'duplicate'
  }
  if (state.referencesByOwner.size >= PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_REFERENCES) {
    throw new Error('Project-reference ownership scan exceeds its reference limit.')
  }
  if (
    !state.sha256s.has(reference.sha256) &&
    state.sha256s.size >= PROJECT_REFERENCE_OWNERSHIP_MAX_ARTIFACTS
  ) {
    throw new Error('Project-reference ownership scan exceeds its artifact limit.')
  }
  const ownerCount = state.ownersPerSha.get(reference.sha256) ?? 0
  if (ownerCount >= PROJECT_REFERENCE_OWNERSHIP_MAX_OWNERS_PER_ARTIFACT) {
    throw new Error('Project-reference ownership scan exceeds its per-artifact owner limit.')
  }
  const referenceBytes = Buffer.byteLength(JSON.stringify(reference), 'utf8')
  const nextBytes = state.serializedBytes + referenceBytes + (state.referencesByOwner.size ? 1 : 0)
  if (nextBytes > PROJECT_REFERENCE_OWNERSHIP_LEDGER_MAX_BYTES) {
    throw new Error('Project-reference ownership scan exceeds its IPC byte limit.')
  }

  state.referencesByOwner.set(key, reference)
  state.sha256s.add(reference.sha256)
  state.ownersPerSha.set(reference.sha256, ownerCount + 1)
  state.serializedBytes = nextBytes
  return 'added'
}

export function validateProjectReferenceOwnershipProjection(
  value: unknown
): ProjectReferenceLegacyArtifactRef[] {
  if (!Array.isArray(value) || value.length > PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_REFERENCES) {
    throw new Error('Project-reference ownership worker returned an invalid projection.')
  }
  const state = emptyScanState()
  for (const reference of value) {
    if (!isProjectReferenceLegacyArtifactRef(reference)) {
      throw new Error('Project-reference ownership worker returned an invalid projection.')
    }
    if (addReference(state, reference) !== 'added') {
      throw new Error('Project-reference ownership worker returned duplicate references.')
    }
  }
  return [...state.referencesByOwner.values()]
}

async function forEachBoundedLine(
  input: fs.ReadStream,
  fileName: string,
  visit: (line: string) => void
): Promise<void> {
  let pending = Buffer.alloc(0)
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(cursor, end)
      if (pending.length + segment.length > PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_LINE_BYTES) {
        throw new Error(
          `Project-reference run-event line exceeds the bounded scan limit: ${fileName}`
        )
      }
      if (newline === -1) {
        pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment)
        break
      }

      let line = pending.length ? Buffer.concat([pending, segment]) : segment
      pending = Buffer.alloc(0)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      visit(line.toString('utf8'))
      cursor = newline + 1
    }
  }
  if (pending.length > 0) visit(pending.toString('utf8'))
}

async function scanRunEventFile(filePath: string, state: ScanState): Promise<FileIdentity> {
  let handle: fs.promises.FileHandle | null = null
  let input: fs.ReadStream | null = null
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    )
    const opened = await handle.stat()
    if (!opened.isFile() || !isMainOwned(opened)) {
      throw new Error(`Project-reference run-event file is unsafe: ${path.basename(filePath)}`)
    }
    input = handle.createReadStream({ autoClose: false })
    await forEachBoundedLine(input, path.basename(filePath), (line) => {
      if (!line.includes(REFERENCE_CONTEXT_KIND_NEEDLE)) return
      const event = parseRunEventLine(line)
      if (!event) {
        throw new Error(
          `Project-reference candidate event is malformed: ${path.basename(filePath)}`
        )
      }
      for (const reference of projectReferenceOwnedArtifactRefsFromRunEvent(event)) {
        addReference(state, reference)
      }
    })

    const openedAfter = await handle.stat()
    const pathAfter = await fs.promises.lstat(filePath)
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileIdentity(opened, openedAfter) ||
      !sameFileIdentity(openedAfter, pathAfter)
    ) {
      throw new Error(
        `Project-reference run-event file identity changed: ${path.basename(filePath)}`
      )
    }
    return identity(openedAfter)
  } finally {
    input?.destroy()
    if (handle) await handle.close().catch(() => undefined)
  }
}

/**
 * Streams the run-event archive and retains only the tiny, deduplicated
 * ownership projection. This function is designed for a utility process: it
 * never mutates the archive and never returns general transcript/provider
 * events to Electron main.
 *
 * Compatibility note: the previous startup path used getRunEventsAsync(),
 * whose parser did not verify per-run hash chains. This scanner deliberately
 * preserves that trust model and labels its worker response
 * `legacy-parse-only`; strict snapshot path/identity/content validation remains
 * main-owned. Candidate records are nevertheless fail-closed when malformed.
 */
export async function scanProjectReferenceOwnership(
  request: ProjectReferenceOwnershipScanRequest
): Promise<ProjectReferenceLegacyArtifactRef[]> {
  const root = await canonicalRunEventsDirectory(request.runEventsDirectory)
  const entries = (await fs.promises.readdir(root.path, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.jsonl'))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (entries.length > PROJECT_REFERENCE_OWNERSHIP_SCAN_MAX_FILES) {
    throw new Error('Project-reference ownership scan exceeds its file limit.')
  }

  const state = emptyScanState()
  const initialFiles = new Map<string, FileIdentity>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry.isFile()) {
      throw new Error(`Project-reference run-event entry is unsafe: ${entry.name}`)
    }
    initialFiles.set(entry.name, await scanRunEventFile(path.join(root.path, entry.name), state))
    if ((index + 1) % 16 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  const rootAfter = await fs.promises.lstat(root.path)
  if (
    rootAfter.isSymbolicLink() ||
    !rootAfter.isDirectory() ||
    !sameFileIdentity(root.identity, rootAfter)
  ) {
    throw new Error('Project-reference run-event directory identity changed during scan.')
  }
  // New run files may be created while the startup hold is active, but they
  // cannot contain a new Project-reference snapshot because that same hold
  // gates capture. Every file that existed at the scan boundary must remain the
  // same inode; disappearance or replacement makes the projection incomplete.
  for (const [fileName, expected] of initialFiles) {
    const current = await fs.promises.lstat(path.join(root.path, fileName))
    if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(expected, current)) {
      throw new Error(`Project-reference run-event generation changed: ${fileName}`)
    }
  }

  return [...state.referencesByOwner.values()].sort(
    (left, right) =>
      left.sha256.localeCompare(right.sha256) ||
      left.appChatId.localeCompare(right.appChatId) ||
      left.runId.localeCompare(right.runId) ||
      left.path.localeCompare(right.path) ||
      left.sizeBytes - right.sizeBytes
  )
}
