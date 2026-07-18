import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_REFERENCE_SNAPSHOT_MAX_BYTES,
  ProjectReferenceArtifactStore,
  snapshotProjectReferenceFile
} from './ProjectReferenceArtifactStore'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'tw-project-reference-')
  )
  roots.push(root)
  return root
}

function makeWorkspace(root: string): string {
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  return workspace
}

function snapshotInput(workspace: string, candidatePath: string, snapshotDirectory: string) {
  return { workspacePath: workspace, candidatePath, snapshotDirectory }
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('ProjectReferenceArtifactStore', () => {
  it('deduplicates identical descriptor snapshots under one content address', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'brief.docx')
    const snapshots = path.join(root, 'project-reference-snapshots')
    const bytes = Buffer.from('document bytes')
    fs.writeFileSync(source, bytes)

    const store = new ProjectReferenceArtifactStore(snapshots)
    const first = store.snapshot({ workspacePath: workspace, candidatePath: source })
    const second = store.snapshot({ workspacePath: workspace, candidatePath: source })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(first.artifact).toEqual(second.artifact)
    expect(first.artifact.path).not.toBe(source)
    expect(fs.readFileSync(first.artifact.path)).toEqual(bytes)
    expect(fs.readdirSync(snapshots).filter((entry) => entry.endsWith('.snapshot'))).toHaveLength(1)
    expect(fs.readdirSync(snapshots).some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })

  it('keeps distinct content-addressed snapshots when the source file changes', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'notes.md')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'first revision')

    const first = snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshots))
    fs.writeFileSync(source, 'second revision')
    const second = snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshots))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(first.artifact.sha256).not.toBe(second.artifact.sha256)
    expect(first.artifact.path).not.toBe(second.artifact.path)
    expect(fs.readFileSync(first.artifact.path, 'utf8')).toBe('first revision')
    expect(fs.readFileSync(second.artifact.path, 'utf8')).toBe('second revision')
  })

  it('caps source reads before allocating an oversized snapshot', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'too-large.bin')
    fs.writeFileSync(source, Buffer.alloc(1))
    fs.truncateSync(source, PROJECT_REFERENCE_SNAPSHOT_MAX_BYTES + 1)

    expect(
      snapshotProjectReferenceFile(
        snapshotInput(workspace, source, path.join(root, 'project-reference-snapshots'))
      )
    ).toEqual({ ok: false, reason: 'too_large' })
  })

  it('rejects folders and symlink escapes instead of snapshotting a non-local regular file', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const snapshots = path.join(root, 'project-reference-snapshots')
    const outside = path.join(root, 'outside.txt')
    const link = path.join(workspace, 'linked-outside.txt')
    fs.writeFileSync(outside, 'outside bytes')
    fs.symlinkSync(outside, link)

    expect(snapshotProjectReferenceFile(snapshotInput(workspace, workspace, snapshots))).toEqual({
      ok: false,
      reason: 'not_file'
    })
    expect(snapshotProjectReferenceFile(snapshotInput(workspace, link, snapshots))).toEqual({
      ok: false,
      reason: 'outside_allowed_roots'
    })
  })

  it('uses descriptor bytes and never exposes the original locator in the durable artifact', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'replaceable-private-plan.txt')
    const replacement = path.join(workspace, 'replacement.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'original approved bytes')

    const result = snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshots))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    fs.writeFileSync(replacement, 'unapproved replacement bytes')
    fs.renameSync(replacement, source)

    expect(fs.readFileSync(result.artifact.path, 'utf8')).toBe('original approved bytes')
    expect(result.artifact.path).not.toBe(source)
    expect(JSON.stringify(result)).not.toContain(source)
    expect(result.artifact.metadata).toEqual({
      source: 'project_reference_context',
      storage: 'main_owned_snapshot'
    })
  })

  it('refuses a symlinked snapshot directory rather than writing into a replaceable location', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'brief.txt')
    const attackerDirectory = path.join(root, 'attacker-writable')
    const snapshotsLink = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'safe source')
    fs.mkdirSync(attackerDirectory)
    fs.symlinkSync(attackerDirectory, snapshotsLink, 'dir')

    expect(snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshotsLink))).toEqual({
      ok: false,
      reason: 'unsafe_snapshot_directory'
    })
    expect(fs.readdirSync(attackerDirectory)).toEqual([])
  })

  it('refuses a snapshot directory inside the workspace even when its POSIX mode is private', () => {
    if (process.platform === 'win32') return
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'brief.txt')
    const snapshots = path.join(workspace, '.project-reference-snapshots')
    fs.chmodSync(workspace, 0o700)
    fs.writeFileSync(source, 'safe source')

    expect(snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshots))).toEqual({
      ok: false,
      reason: 'unsafe_snapshot_directory'
    })
  })
})
