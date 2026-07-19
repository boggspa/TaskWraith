import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_REFERENCE_SNAPSHOT_MAX_BYTES,
  ProjectReferenceArtifactStore,
  snapshotProjectReferenceFile
} from './ProjectReferenceArtifactStore'
import {
  PROJECT_REFERENCE_OWNERSHIP_FILE,
  PROJECT_REFERENCE_PURGE_JOURNAL_FILE
} from './ProjectReferenceArtifactLedger'

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
  vi.restoreAllMocks()
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

  it('atomically owns a shared hash and deletes bytes only after its final chat/run owner', async () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'shared.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'shared project reference')
    const store = new ProjectReferenceArtifactStore(snapshots)

    const first = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: source }]
    })
    const second = store.snapshotOwnedMany({
      appChatId: 'chat-b',
      runId: 'run-b',
      files: [{ workspacePath: workspace, candidatePath: source }]
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.artifacts).toEqual(second.artifacts)
    const sha256 = first.artifacts[0].sha256!
    const artifactPath = first.artifacts[0].path!
    expect(store.commitOwnedBatch(first.receipt)).toBe(true)
    expect(store.commitOwnedBatch(second.receipt)).toBe(true)
    expect(new ProjectReferenceArtifactStore(snapshots).owns(sha256, {
      appChatId: 'chat-a',
      runId: 'run-a'
    })).toBe(true)

    await expect(
      store.revokeOwnershipStrict({ appChatIds: ['chat-a'], runIds: [] })
    ).resolves.toEqual({ revokedOwners: 1, deletedArtifacts: 0 })
    expect(fs.existsSync(artifactPath)).toBe(true)
    expect(store.owns(sha256, { appChatId: 'chat-b', runId: 'run-b' })).toBe(true)

    await expect(
      store.revokeOwnershipStrict({ appChatIds: [], runIds: ['run-b'] })
    ).resolves.toEqual({ revokedOwners: 1, deletedArtifacts: 1 })
    expect(fs.existsSync(artifactPath)).toBe(false)
  })

  it('rolls back exact new inodes when a later file in the owned batch fails', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'first.txt')
    const missing = path.join(workspace, 'missing.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    const bytes = Buffer.from('first owned snapshot')
    fs.writeFileSync(source, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const store = new ProjectReferenceArtifactStore(snapshots)

    expect(
      store.snapshotOwnedMany({
        appChatId: 'chat-a',
        runId: 'run-a',
        files: [
          { workspacePath: workspace, candidatePath: source },
          { workspacePath: workspace, candidatePath: missing }
        ]
      })
    ).toEqual({ ok: false, reason: 'missing', failedAt: 1 })
    expect(fs.existsSync(path.join(snapshots, `${sha256}.snapshot`))).toBe(false)
    expect(fs.existsSync(path.join(snapshots, PROJECT_REFERENCE_OWNERSHIP_FILE))).toBe(false)
    expect(fs.readdirSync(snapshots).some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })

  it('rolls back batch bytes when the ownership ledger cannot publish', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'ledger-failure.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    const bytes = Buffer.from('owned snapshot ledger failure')
    fs.writeFileSync(source, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const store = new ProjectReferenceArtifactStore(snapshots)
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated ownership rename failure')
    })

    expect(
      store.snapshotOwnedMany({
        appChatId: 'chat-a',
        runId: 'run-a',
        files: [{ workspacePath: workspace, candidatePath: source }]
      })
    ).toEqual({ ok: false, reason: 'ownership_failed' })
    expect(fs.existsSync(path.join(snapshots, `${sha256}.snapshot`))).toBe(false)
  })

  it('uses the batch receipt to undo only newly added owners after event append failure', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const sharedSource = path.join(workspace, 'receipt-shared.txt')
    const freshSource = path.join(workspace, 'receipt-fresh.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(sharedSource, 'receipt shared')
    fs.writeFileSync(freshSource, 'receipt fresh')
    const store = new ProjectReferenceArtifactStore(snapshots)
    const baseline = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: sharedSource }]
    })
    expect(baseline.ok).toBe(true)
    if (!baseline.ok) return
    store.commitOwnedBatch(baseline.receipt)
    const sharedPath = baseline.artifacts[0].path!
    const sharedSha = baseline.artifacts[0].sha256!

    const replay = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: sharedSource }]
    })
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(store.rollbackOwnedBatch(replay.receipt)).toEqual({
      revokedOwners: 0,
      deletedArtifacts: 0
    })
    expect(fs.existsSync(sharedPath)).toBe(true)
    expect(store.owns(sharedSha, { appChatId: 'chat-a', runId: 'run-a' })).toBe(true)

    const pending = store.snapshotOwnedMany({
      appChatId: 'chat-b',
      runId: 'run-b',
      files: [
        { workspacePath: workspace, candidatePath: sharedSource },
        { workspacePath: workspace, candidatePath: freshSource }
      ]
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    const freshPath = pending.artifacts[1].path!
    expect(store.rollbackOwnedBatch(pending.receipt)).toEqual({
      revokedOwners: 2,
      deletedArtifacts: 1
    })
    expect(fs.existsSync(sharedPath)).toBe(true)
    expect(fs.existsSync(freshPath)).toBe(false)
    expect(store.owns(sharedSha, { appChatId: 'chat-a', runId: 'run-a' })).toBe(true)
  })

  it('reconciles pre-ledger run-event references and strictly prunes legacy orphans', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const referencedSource = path.join(workspace, 'legacy-referenced.txt')
    const orphanSource = path.join(workspace, 'legacy-orphan.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(referencedSource, 'legacy referenced')
    fs.writeFileSync(orphanSource, 'legacy orphan')
    const referenced = snapshotProjectReferenceFile(
      snapshotInput(workspace, referencedSource, snapshots)
    )
    const orphan = snapshotProjectReferenceFile(snapshotInput(workspace, orphanSource, snapshots))
    expect(referenced.ok).toBe(true)
    expect(orphan.ok).toBe(true)
    if (!referenced.ok || !orphan.ok) return

    const store = new ProjectReferenceArtifactStore(snapshots)
    expect(store.needsLegacyReconciliation()).toBe(true)
    expect(
      store.snapshotOwnedMany({
        appChatId: 'chat-new',
        runId: 'run-new',
        files: [{ workspacePath: workspace, candidatePath: referencedSource }]
      })
    ).toEqual({ ok: false, reason: 'ownership_failed' })
    expect(
      store.reconcileLegacyOwnership([
        {
          sha256: referenced.artifact.sha256!,
          path: referenced.artifact.path!,
          sizeBytes: referenced.artifact.sizeBytes!,
          appChatId: 'chat-a',
          runId: 'run-a'
        }
      ])
    ).toEqual({ referencedArtifacts: 1, deletedOrphans: 1 })
    expect(fs.existsSync(referenced.artifact.path!)).toBe(true)
    expect(fs.existsSync(orphan.artifact.path!)).toBe(false)
    expect(store.needsLegacyReconciliation()).toBe(false)
    expect(new ProjectReferenceArtifactStore(snapshots).owns(referenced.artifact.sha256!, {
      appChatId: 'chat-a',
      runId: 'run-a'
    })).toBe(true)
  })

  it('repairs ledger/event drift on every restart in both directions', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const staleOwnedSource = path.join(workspace, 'stale-owned.txt')
    const reachableUnownedSource = path.join(workspace, 'reachable-unowned.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(staleOwnedSource, 'ledger owner without durable event')
    fs.writeFileSync(reachableUnownedSource, 'durable event without ledger owner')
    const initial = new ProjectReferenceArtifactStore(snapshots)
    const staleOwned = initial.snapshotOwnedMany({
      appChatId: 'stale-chat',
      runId: 'stale-run',
      files: [{ workspacePath: workspace, candidatePath: staleOwnedSource }]
    })
    expect(staleOwned.ok).toBe(true)
    if (!staleOwned.ok) return
    initial.commitOwnedBatch(staleOwned.receipt)
    const reachableUnowned = snapshotProjectReferenceFile(
      snapshotInput(workspace, reachableUnownedSource, snapshots)
    )
    expect(reachableUnowned.ok).toBe(true)
    if (!reachableUnowned.ok) return

    const restarted = new ProjectReferenceArtifactStore(snapshots)
    expect(restarted.needsLegacyReconciliation()).toBe(true)
    expect(
      restarted.reconcileLegacyOwnership([
        {
          sha256: reachableUnowned.artifact.sha256!,
          path: reachableUnowned.artifact.path!,
          sizeBytes: reachableUnowned.artifact.sizeBytes!,
          appChatId: 'reachable-chat',
          runId: 'reachable-run'
        }
      ])
    ).toEqual({ referencedArtifacts: 1, deletedOrphans: 1 })
    expect(fs.existsSync(staleOwned.artifacts[0].path!)).toBe(false)
    expect(restarted.owns(staleOwned.artifacts[0].sha256!, {
      appChatId: 'stale-chat',
      runId: 'stale-run'
    })).toBe(false)
    expect(fs.existsSync(reachableUnowned.artifact.path!)).toBe(true)
    expect(restarted.owns(reachableUnowned.artifact.sha256!, {
      appChatId: 'reachable-chat',
      runId: 'reachable-run'
    })).toBe(true)
  })

  it('reconciles the post-delete projection after a purge receipt while preserving shared bytes', async () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const sharedSource = path.join(workspace, 'shared.txt')
    const deletedOnlySource = path.join(workspace, 'deleted-only.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(sharedSource, 'shared survivor bytes')
    fs.writeFileSync(deletedOnlySource, 'deleted-only bytes')
    const store = new ProjectReferenceArtifactStore(snapshots)
    const deleted = store.snapshotOwnedMany({
      appChatId: 'deleted-chat',
      runId: 'deleted-run',
      files: [
        { workspacePath: workspace, candidatePath: sharedSource },
        { workspacePath: workspace, candidatePath: deletedOnlySource }
      ]
    })
    const survivor = store.snapshotOwnedMany({
      appChatId: 'survivor-chat',
      runId: 'survivor-run',
      files: [{ workspacePath: workspace, candidatePath: sharedSource }]
    })
    expect(deleted.ok).toBe(true)
    expect(survivor.ok).toBe(true)
    if (!deleted.ok || !survivor.ok) return
    store.commitOwnedBatch(deleted.receipt)
    store.commitOwnedBatch(survivor.receipt)
    const sharedArtifact = survivor.artifacts[0]
    const deletedOnlyArtifact = deleted.artifacts[1]

    await store.revokeOwnershipStrict({
      appChatIds: ['deleted-chat'],
      runIds: ['deleted-run']
    })
    expect(fs.existsSync(deletedOnlyArtifact.path)).toBe(false)
    expect(fs.existsSync(sharedArtifact.path)).toBe(true)

    // Crash boundary: the outer intent and stale deleted-owner events still
    // exist, but startup supplies only the post-delete reachability projection.
    const restarted = new ProjectReferenceArtifactStore(snapshots)
    expect(() =>
      restarted.reconcileLegacyOwnership([
        {
          sha256: sharedArtifact.sha256,
          path: sharedArtifact.path,
          sizeBytes: sharedArtifact.sizeBytes,
          appChatId: 'survivor-chat',
          runId: 'survivor-run'
        }
      ])
    ).not.toThrow()
    expect(restarted.owns(sharedArtifact.sha256, {
      appChatId: 'survivor-chat',
      runId: 'survivor-run'
    })).toBe(true)
    expect(restarted.owns(sharedArtifact.sha256, {
      appChatId: 'deleted-chat',
      runId: 'deleted-run'
    })).toBe(false)
  })

  it('reconciles more than the retired 512-owner-per-hash ceiling', () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'widely-reused.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'widely reused project reference')
    const legacy = snapshotProjectReferenceFile(snapshotInput(workspace, source, snapshots))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) return
    const store = new ProjectReferenceArtifactStore(snapshots)
    const references = Array.from({ length: 600 }, (_, index) => ({
      sha256: legacy.artifact.sha256!,
      path: legacy.artifact.path!,
      sizeBytes: legacy.artifact.sizeBytes!,
      appChatId: `chat-${index}`,
      runId: `run-${index}`
    }))

    expect(store.reconcileLegacyOwnership(references)).toEqual({
      referencedArtifacts: 1,
      deletedOrphans: 0
    })
    expect(store.owns(legacy.artifact.sha256!, {
      appChatId: 'chat-599',
      runId: 'run-599'
    })).toBe(true)
  })

  it('keeps the transaction hold after purge receipt and blocks post-receipt staging', async () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const oldSource = path.join(workspace, 'held-old.txt')
    const lateSource = path.join(workspace, 'held-late.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(oldSource, 'held old')
    fs.writeFileSync(lateSource, 'held late')
    const store = new ProjectReferenceArtifactStore(snapshots)
    const old = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: oldSource }]
    })
    expect(old.ok).toBe(true)
    if (!old.ok) return
    store.commitOwnedBatch(old.receipt)
    const hold = store.beginHistoryMutation({ kind: 'chat', appChatIds: ['chat-a'] })

    await expect(
      store.revokeOwnershipStrict({ appChatIds: ['chat-a'], runIds: ['run-a'] })
    ).resolves.toEqual({ revokedOwners: 1, deletedArtifacts: 1 })
    expect(
      store.snapshotOwnedMany({
        appChatId: 'chat-a',
        runId: 'late-run',
        files: [{ workspacePath: workspace, candidatePath: lateSource }]
      })
    ).toEqual({ ok: false, reason: 'ownership_failed' })
    expect(store.endHistoryMutation(hold)).toBe(true)
  })

  it('globally clears owned snapshots, legacy bytes, ledger, temps, and journal state', async () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const ownedSource = path.join(workspace, 'global-owned.txt')
    const legacySource = path.join(workspace, 'global-legacy.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(ownedSource, 'global owned')
    fs.writeFileSync(legacySource, 'global legacy')
    const store = new ProjectReferenceArtifactStore(snapshots)
    const owned = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: ownedSource }]
    })
    expect(owned.ok).toBe(true)
    if (!owned.ok) return
    store.commitOwnedBatch(owned.receipt)
    const legacy = snapshotProjectReferenceFile(snapshotInput(workspace, legacySource, snapshots))
    expect(legacy.ok).toBe(true)
    fs.writeFileSync(path.join(snapshots, '.stale-private.tmp'), 'stale', { mode: 0o600 })

    await expect(store.clearAllStrict()).resolves.toEqual({
      revokedOwners: 1,
      deletedArtifacts: 2
    })
    expect(fs.readdirSync(snapshots)).toEqual([])
  })

  it('recovers both pre-commit rollback and post-commit cleanup from the purge journal', async () => {
    const root = makeRoot()
    const workspace = makeWorkspace(root)
    const source = path.join(workspace, 'recover.txt')
    const snapshots = path.join(root, 'project-reference-snapshots')
    fs.writeFileSync(source, 'recover project reference')
    const store = new ProjectReferenceArtifactStore(snapshots)
    const owned = store.snapshotOwnedMany({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [{ workspacePath: workspace, candidatePath: source }]
    })
    expect(owned.ok).toBe(true)
    if (!owned.ok) return
    store.commitOwnedBatch(owned.receipt)
    const artifact = owned.artifacts[0]
    const realRename = fs.renameSync.bind(fs)
    let commitBlocked = false
    let rollbackBlocked = false
    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (
        !commitBlocked &&
        typeof oldPath === 'string' &&
        path.basename(oldPath).startsWith('.purge-ledger-') &&
        newPath === path.join(snapshots, PROJECT_REFERENCE_OWNERSHIP_FILE)
      ) {
        commitBlocked = true
        throw new Error('simulated precommit crash')
      }
      if (
        commitBlocked &&
        typeof oldPath === 'string' &&
        path.basename(oldPath).startsWith('.purge-') &&
        !path.basename(oldPath).startsWith('.purge-ledger-')
      ) {
        rollbackBlocked = true
        throw new Error('simulated rollback unavailable')
      }
      return realRename(oldPath, newPath)
    })
    await expect(
      store.revokeOwnershipStrict({ appChatIds: ['chat-a'], runIds: [] })
    ).rejects.toThrow(/before history commit/)
    expect(commitBlocked).toBe(true)
    expect(rollbackBlocked).toBe(true)
    expect(fs.existsSync(path.join(snapshots, PROJECT_REFERENCE_PURGE_JOURNAL_FILE))).toBe(true)
    vi.restoreAllMocks()
    const recovered = new ProjectReferenceArtifactStore(snapshots)
    expect(fs.existsSync(artifact.path!)).toBe(true)
    expect(recovered.owns(artifact.sha256!, { appChatId: 'chat-a', runId: 'run-a' })).toBe(true)
    recovered.reconcileLegacyOwnership([
      {
        sha256: artifact.sha256!,
        path: artifact.path!,
        sizeBytes: artifact.sizeBytes!,
        appChatId: 'chat-a',
        runId: 'run-a'
      }
    ])

    const realUnlink = fs.unlinkSync.bind(fs)
    let cleanupBlocked = false
    vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
      if (
        !cleanupBlocked &&
        typeof filePath === 'string' &&
        path.basename(filePath).startsWith('.purge-')
      ) {
        cleanupBlocked = true
        throw new Error('simulated postcommit cleanup crash')
      }
      return realUnlink(filePath)
    })
    await expect(
      recovered.revokeOwnershipStrict({ appChatIds: ['chat-a'], runIds: [] })
    ).rejects.toThrow(/before history commit/)
    expect(cleanupBlocked).toBe(true)
    vi.restoreAllMocks()
    const finished = new ProjectReferenceArtifactStore(snapshots)
    expect(fs.existsSync(artifact.path!)).toBe(false)
    expect(fs.existsSync(path.join(snapshots, PROJECT_REFERENCE_PURGE_JOURNAL_FILE))).toBe(false)
    expect(finished.owns(artifact.sha256!, { appChatId: 'chat-a', runId: 'run-a' })).toBe(false)
  })
})
