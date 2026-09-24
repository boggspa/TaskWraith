import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readScopedRegularFile,
  readScopedRegularFileLineWindow,
  writeScopedUtf8FileWithLegacyCreate
} from '../ScopedPathAccess'
import {
  bindSharedWorkspaceActor,
  currentSharedWorkspaceActor,
  withSharedWorkspaceOperation
} from './SharedWorkspaceSession'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-read-')))
  roots.push(rootPath)
  const targetPath = path.join(rootPath, 'source.txt')
  fs.writeFileSync(targetPath, 'initial\nsecond line\n')
  return { rootPath, targetPath }
}

function seat<T>(chatId: string, operation: () => T, participantId = 'worker'): T {
  return withSharedWorkspaceOperation(() => {
    bindSharedWorkspaceActor(
      {
        scope: 'workspace',
        appChatId: chatId,
        appRunId: randomUUID(),
        ensembleRun: { participantId }
      },
      'codex',
      'read_file'
    )
    return operation()
  })
}

describe('shared workspace read-to-write protection', () => {
  it('preserves a peer edit made while an agent was reasoning, then accepts a refreshed edit', async () => {
    const authority = fixture()
    const a = randomUUID()
    const b = randomUUID()
    await seat(a, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    await seat(b, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    await seat(a, () =>
      writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'A\n' })
    )
    await expect(
      seat(b, () =>
        writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'B\n' })
      )
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('A\n')
    await seat(b, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    await seat(b, () =>
      writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'A+B\n' })
    )
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('A+B\n')
  })

  it('keeps same-provider participants in one chat separate across turns', async () => {
    const authority = fixture()
    const chat = randomUUID()
    await seat(chat, () => readScopedRegularFile(authority, { maxBytes: 1000 }), 'one')
    await seat(chat, () => readScopedRegularFile(authority, { maxBytes: 1000 }), 'two')
    await seat(
      chat,
      () => writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'one' }),
      'one'
    )
    await expect(
      seat(
        chat,
        () => writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'two' }),
        'two'
      )
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    await seat(
      chat,
      () =>
        writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'one again' }),
      'one'
    )
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('one again')
  })

  it('protects a whole-file write after reading only a line window', async () => {
    const authority = fixture()
    const chat = randomUUID()
    await seat(chat, () =>
      readScopedRegularFileLineWindow(
        authority,
        { startLine: 1, maxLines: 1 },
        { maxWindowBytes: 1000 }
      )
    )
    fs.appendFileSync(authority.targetPath, 'peer changed an unseen line\n')
    await expect(
      seat(chat, () =>
        writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'stale' })
      )
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toContain('peer changed')
  })

  it('does not overwrite a change made during an awaited approval callback', async () => {
    const authority = fixture()
    await expect(
      writeScopedUtf8FileWithLegacyCreate(authority, {
        maxBytes: 1000,
        content: 'stale',
        beforeCommit: () => {
          fs.writeFileSync(authority.targetPath, 'native peer')
        }
      })
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('native peer')
  })

  it('requires observing a deletion before recreating a previously read file', async () => {
    const authority = fixture()
    const chat = randomUUID()
    await seat(chat, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    fs.unlinkSync(authority.targetPath)
    await expect(
      seat(chat, () =>
        writeScopedUtf8FileWithLegacyCreate(authority, {
          maxBytes: 1000,
          content: 'stale recreation'
        })
      )
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    expect(fs.existsSync(authority.targetPath)).toBe(false)
    await expect(
      seat(chat, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    ).rejects.toThrow()
    await seat(chat, () =>
      writeScopedUtf8FileWithLegacyCreate(authority, {
        maxBytes: 1000,
        content: 'intentional recreation'
      })
    )
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('intentional recreation')
  })

  it('requires observing a deletion even when the workspace root is reached through a symlink', async () => {
    // Reads remember the CANONICAL target while the recreate branch once
    // checked the RAW one, so a root that is not its own realpath (a symlinked
    // directory here; an 8.3 short name on Windows) bypassed the guard.
    const canonical = fixture()
    const link = path.join(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-link-'))),
      'repo'
    )
    roots.push(path.dirname(link))
    fs.symlinkSync(canonical.rootPath, link, 'junction')
    const authority = { rootPath: link, targetPath: path.join(link, 'source.txt') }
    expect(fs.realpathSync.native(authority.rootPath)).not.toBe(authority.rootPath)
    const chat = randomUUID()
    await seat(chat, () => readScopedRegularFile(authority, { maxBytes: 1000 }))
    fs.unlinkSync(canonical.targetPath)
    await expect(
      seat(chat, () =>
        writeScopedUtf8FileWithLegacyCreate(authority, {
          maxBytes: 1000,
          content: 'stale recreation'
        })
      )
    ).rejects.toThrow('WORKSPACE_STALE_READ')
    expect(fs.existsSync(canonical.targetPath)).toBe(false)
  })

  it('does not impose a read prerequisite on an unobserved write', async () => {
    const authority = fixture()
    await seat(randomUUID(), () =>
      writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 1000, content: 'new content' })
    )
    expect(fs.readFileSync(authority.targetPath, 'utf8')).toBe('new content')
  })

  it('does not share ambient identity between interleaved tool calls', async () => {
    const chatA = randomUUID()
    const chatB = randomUUID()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = seat(chatA, async () => {
      await pending
      return currentSharedWorkspaceActor()?.chatId
    })
    const b = await seat(chatB, async () => {
      release()
      await Promise.resolve()
      return currentSharedWorkspaceActor()?.chatId
    })
    expect(await a).toBe(chatA)
    expect(b).toBe(chatB)
    expect(currentSharedWorkspaceActor()).toBeUndefined()
  })
})
