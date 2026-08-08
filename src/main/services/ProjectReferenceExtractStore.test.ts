import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_REFERENCE_EXTRACTS_DIR_NAME,
  ProjectReferenceExtractStore
} from './ProjectReferenceExtractStore'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tw-extract-store-'))
  roots.push(root)
  return root
}

function extractDir(root: string): string {
  return path.join(root, PROJECT_REFERENCE_EXTRACTS_DIR_NAME)
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

const consent = {
  at: 100,
  actor: 'user' as const,
  scope: 'this-reference' as const,
  chatId: 'chat-a'
}

describe('ProjectReferenceExtractStore', () => {
  it('round-trips pending → ready text under a private 0700 root', () => {
    if (process.platform === 'win32') return
    const root = makeRoot()
    const store = new ProjectReferenceExtractStore(extractDir(root))
    const pending = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'plain-text',
      consent,
      source: { locator: '/workspace/notes.txt' },
      now: 100
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    expect(pending.extract.status).toBe('pending')

    const ready = store.markReady(pending.extract.id, 'hello extract', { now: 110 })
    expect(ready.ok).toBe(true)
    if (!ready.ok) return
    expect(ready.extract.status).toBe('ready')
    expect(ready.extract.text?.charCount).toBe('hello extract'.length)
    expect(ready.extract.text?.artifactSha256).toBe(
      createHash('sha256').update('hello extract', 'utf8').digest('hex')
    )

    const active = store.getActive('project-a', 'ref-a')
    expect(active?.id).toBe(pending.extract.id)
    expect(store.getById(pending.extract.id)).toEqual(ready.extract)
    expect(store.readText(pending.extract.id)).toBe('hello extract')

    // @portability-ok — extract store mkdir uses 0o700; NTFS mode bits are not meaningful.
    const mode = fs.statSync(extractDir(root)).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('revokes by deleting content-addressed bytes and marking revoked', () => {
    const root = makeRoot()
    const store = new ProjectReferenceExtractStore(extractDir(root))
    const pending = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'url-html',
      consent,
      source: { locator: 'https://example.com/a' },
      now: 1
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    const ready = store.markReady(pending.extract.id, 'body text', { now: 2 })
    expect(ready.ok).toBe(true)
    if (!ready.ok) return

    const sha = ready.extract.text!.artifactSha256
    const blobPath = path.join(extractDir(root), 'blobs', `${sha}.txt`)
    expect(fs.existsSync(blobPath)).toBe(true)

    const revoked = store.revoke(pending.extract.id, { now: 3 })
    expect(revoked.ok).toBe(true)
    if (!revoked.ok) return
    expect(revoked.extract.status).toBe('revoked')
    expect(revoked.extract.revokedAt).toBe(3)
    expect(fs.existsSync(blobPath)).toBe(false)
    expect(store.readText(pending.extract.id)).toBeNull()
    expect(store.getActive('project-a', 'ref-a')).toBeNull()
  })

  it('keeps one active extract per project/reference and purges on reference', () => {
    const root = makeRoot()
    const store = new ProjectReferenceExtractStore(extractDir(root))
    const first = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'pdf-text',
      consent,
      source: { locator: '/workspace/a.pdf', pageRange: { first: 1, last: 1 } },
      now: 1
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(store.markReady(first.extract.id, 'first body', { now: 2 }).ok).toBe(true)

    const second = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'pdf-text',
      consent: { ...consent, at: 3 },
      source: { locator: '/workspace/a.pdf', pageRange: { first: 1, last: 2 } },
      now: 3
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(store.getActive('project-a', 'ref-a')?.id).toBe(second.extract.id)
    expect(store.getById(first.extract.id)?.status).toBe('stale')
    expect(store.readText(first.extract.id)).toBeNull()

    expect(store.markReady(second.extract.id, 'second body', { now: 4 }).ok).toBe(true)
    const purged = store.purgeForReference('project-a', 'ref-a')
    expect(purged.ok).toBe(true)
    if (!purged.ok) return
    expect(purged.deletedExtracts).toBeGreaterThanOrEqual(2)
    expect(store.getActive('project-a', 'ref-a')).toBeNull()
    expect(store.getById(second.extract.id)).toBeNull()
    expect(store.readText(second.extract.id)).toBeNull()
  })

  it('marks failed without writing bytes and fails closed on corrupt meta', () => {
    const root = makeRoot()
    const dir = extractDir(root)
    const store = new ProjectReferenceExtractStore(dir)
    const pending = store.putPending({
      projectId: 'project-b',
      referenceId: 'ref-b',
      kind: 'office-text',
      consent,
      source: { locator: '/workspace/a.docx', officeFormat: 'docx' },
      now: 1
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) return

    const failed = store.markFailed(
      pending.extract.id,
      { code: 'unsupported', message: 'Could not parse office document' },
      { now: 2 }
    )
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.extract.status).toBe('failed')
    expect(failed.extract.error).toEqual({
      code: 'unsupported',
      message: 'Could not parse office document'
    })
    expect(fs.existsSync(path.join(dir, 'blobs'))).toBe(true)
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toEqual([])

    const metaPath = path.join(dir, 'meta', `${pending.extract.id}.json`)
    fs.writeFileSync(metaPath, '{not-json', 'utf8')
    expect(store.getById(pending.extract.id)).toBeNull()
    expect(store.getActive('project-b', 'ref-b')).toBeNull()
  })

  it('purgeForProject removes every extract for that project only', () => {
    const root = makeRoot()
    const store = new ProjectReferenceExtractStore(extractDir(root))
    const a = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-1',
      kind: 'plain-text',
      consent,
      source: { locator: '/workspace/a.txt' },
      now: 1
    })
    const b = store.putPending({
      projectId: 'project-b',
      referenceId: 'ref-2',
      kind: 'plain-text',
      consent,
      source: { locator: '/workspace/b.txt' },
      now: 1
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(store.markReady(a.extract.id, 'a', { now: 2 }).ok).toBe(true)
    expect(store.markReady(b.extract.id, 'b', { now: 2 }).ok).toBe(true)

    const purged = store.purgeForProject('project-a')
    expect(purged.ok).toBe(true)
    expect(store.getById(a.extract.id)).toBeNull()
    expect(store.getActive('project-b', 'ref-2')?.id).toBe(b.extract.id)
    expect(store.readText(b.extract.id)).toBe('b')
  })

  it('refuses a symlinked extract root', () => {
    const root = makeRoot()
    const attacker = path.join(root, 'attacker')
    const linked = path.join(root, PROJECT_REFERENCE_EXTRACTS_DIR_NAME)
    fs.mkdirSync(attacker)
    fs.symlinkSync(attacker, linked, 'dir')
    const store = new ProjectReferenceExtractStore(linked)
    const result = store.putPending({
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'plain-text',
      consent,
      source: { locator: '/workspace/a.txt' },
      now: 1
    })
    expect(result).toEqual({ ok: false, reason: 'unsafe_extract_directory' })
    expect(fs.readdirSync(attacker)).toEqual([])
  })
})
