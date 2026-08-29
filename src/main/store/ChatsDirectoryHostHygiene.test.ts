import { describe, expect, it } from 'vitest'

import {
  CHAT_FILE_MODE,
  chatsDirectoryHygieneChangedAnything,
  repairChatsDirectoryForHost,
  type ChatsDirectoryHygieneDeps
} from './ChatsDirectoryHostHygiene'

type Kind = 'file' | 'dir' | 'symlink'
interface Node {
  kind: Kind
  mode: number
}

/** A fake tree keyed by POSIX-ish path, so the repair is exercised without
 *  touching a real profile. */
function fakeFs(initial: Record<string, Node>) {
  const nodes = new Map(Object.entries(initial))
  const join = (...parts: string[]) => parts.join('/')
  const deps: ChatsDirectoryHygieneDeps = {
    join,
    exists: (p) => nodes.has(p),
    readdir: (p) => {
      // Real fs.readdirSync throws on a missing directory; a fake that returns
      // [] would let the caller's existence guard rot untested.
      if (!nodes.has(p)) throw new Error(`ENOENT: ${p}`)
      const prefix = `${p}/`
      const names = new Set<string>()
      for (const key of nodes.keys()) {
        if (!key.startsWith(prefix)) continue
        names.add(key.slice(prefix.length).split('/')[0])
      }
      return [...names].sort().map((name) => {
        const node = nodes.get(join(p, name))!
        return {
          name,
          isFile: () => node.kind === 'file',
          isDirectory: () => node.kind === 'dir',
          isSymbolicLink: () => node.kind === 'symlink'
        }
      })
    },
    mode: (p) => nodes.get(p)?.mode ?? null,
    chmod: (p, mode) => {
      const node = nodes.get(p)
      if (node) nodes.set(p, { ...node, mode })
    },
    ensureDir: (p) => {
      if (!nodes.has(p)) nodes.set(p, { kind: 'dir', mode: 0o700 })
    },
    rename: (from, to) => {
      if (nodes.has(to)) throw new Error(`refusing to clobber ${to}`)
      const node = nodes.get(from)
      if (!node) throw new Error(`missing ${from}`)
      nodes.delete(from)
      nodes.set(to, node)
    },
    removeDirectoryIfEmpty: (p) => {
      const prefix = `${p}/`
      for (const key of nodes.keys()) if (key.startsWith(prefix)) return
      nodes.delete(p)
    }
  }
  return { nodes, deps }
}

const CHATS = '/profile/chats'
const OVERLAY = '/profile/chat-composer-selections'
const run = (deps: ChatsDirectoryHygieneDeps, platform = 'darwin') =>
  repairChatsDirectoryForHost({ chatsDir: CHATS, overlayDir: OVERLAY, deps, platform })

describe('chats directory host hygiene', () => {
  it('does nothing to a directory the Host would already accept', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/a.json`]: { kind: 'file', mode: 0o600 }
    })

    const report = run(deps)

    expect(report.tightenedFileModes).toBe(0)
    expect(report.relocatedOverlayFiles).toBe(0)
    expect(report.unrepairableEntries).toEqual([])
    expect(chatsDirectoryHygieneChangedAnything(report)).toBe(false)
    expect(nodes.get(`${CHATS}/a.json`)!.mode).toBe(0o600)
  })

  it('relocates the legacy overlay directory out of chats/ and clears it', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/.composer-selections`]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/.composer-selections/one.json`]: { kind: 'file', mode: 0o600 },
      [`${CHATS}/.composer-selections/two.json`]: { kind: 'file', mode: 0o600 }
    })

    const report = run(deps)

    expect(report.relocatedOverlayFiles).toBe(2)
    expect(report.legacyOverlayDirectoryCleared).toBe(true)
    expect(nodes.has(`${OVERLAY}/one.json`)).toBe(true)
    expect(nodes.has(`${OVERLAY}/two.json`)).toBe(true)
    expect(nodes.has(`${CHATS}/.composer-selections`)).toBe(false)
  })

  it('never clobbers an overlay the relocated store already wrote', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [OVERLAY]: { kind: 'dir', mode: 0o700 },
      [`${OVERLAY}/one.json`]: { kind: 'file', mode: 0o600 },
      [`${CHATS}/.composer-selections`]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/.composer-selections/one.json`]: { kind: 'file', mode: 0o600 }
    })

    const report = run(deps)

    expect(report.overlayConflicts).toBe(1)
    expect(report.relocatedOverlayFiles).toBe(0)
    // The legacy copy survives for a human rather than either being destroyed.
    expect(nodes.has(`${CHATS}/.composer-selections/one.json`)).toBe(true)
    expect(report.legacyOverlayDirectoryCleared).toBe(false)
  })

  it('tightens world-readable chat files to owner-only', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/old.json`]: { kind: 'file', mode: 0o644 },
      [`${CHATS}/group.json`]: { kind: 'file', mode: 0o640 },
      [`${CHATS}/fine.json`]: { kind: 'file', mode: 0o600 }
    })

    const report = run(deps)

    expect(report.tightenedFileModes).toBe(2)
    expect(nodes.get(`${CHATS}/old.json`)!.mode).toBe(CHAT_FILE_MODE)
    expect(nodes.get(`${CHATS}/group.json`)!.mode).toBe(CHAT_FILE_MODE)
    expect(nodes.get(`${CHATS}/fine.json`)!.mode).toBe(0o600)
  })

  it('leaves modes alone on win32, exactly as the Host check does', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/old.json`]: { kind: 'file', mode: 0o644 }
    })

    const report = run(deps, 'win32')

    expect(report.tightenedFileModes).toBe(0)
    expect(nodes.get(`${CHATS}/old.json`)!.mode).toBe(0o644)
  })

  it('reports a symlink instead of chmod-ing or removing it', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/evil.json`]: { kind: 'symlink', mode: 0o777 }
    })

    const report = run(deps)

    expect(report.unrepairableEntries).toEqual(['evil.json'])
    expect(report.tightenedFileModes).toBe(0)
    expect(nodes.get(`${CHATS}/evil.json`)!.mode).toBe(0o777)
  })

  it('reports a foreign directory rather than deleting it', () => {
    const { deps, nodes } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/something-else`]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/something-else/x.json`]: { kind: 'file', mode: 0o600 }
    })

    const report = run(deps)

    expect(report.unrepairableEntries).toEqual(['something-else'])
    expect(nodes.has(`${CHATS}/something-else/x.json`)).toBe(true)
  })

  it('reports a non-chat file rather than removing it', () => {
    const { deps } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/README.md`]: { kind: 'file', mode: 0o644 }
    })

    expect(run(deps).unrepairableEntries).toEqual(['README.md'])
  })

  it('tolerates the temp names the Host itself tolerates', () => {
    const { deps } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/.tw-1234.tmp`]: { kind: 'file', mode: 0o600 },
      [`${CHATS}/abc.json.123.aB-c_1.tmp`]: { kind: 'file', mode: 0o600 }
    })

    expect(run(deps).unrepairableEntries).toEqual([])
  })

  it('is idempotent — a second pass changes nothing', () => {
    const { deps } = fakeFs({
      [CHATS]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/old.json`]: { kind: 'file', mode: 0o644 },
      [`${CHATS}/.composer-selections`]: { kind: 'dir', mode: 0o700 },
      [`${CHATS}/.composer-selections/one.json`]: { kind: 'file', mode: 0o600 }
    })

    const first = run(deps)
    const second = run(deps)

    expect(chatsDirectoryHygieneChangedAnything(first)).toBe(true)
    expect(chatsDirectoryHygieneChangedAnything(second)).toBe(false)
    expect(second.tightenedFileModes).toBe(0)
    expect(second.relocatedOverlayFiles).toBe(0)
  })

  it('is a no-op when there is no chats directory yet', () => {
    const { deps } = fakeFs({})

    const report = run(deps)

    expect(chatsDirectoryHygieneChangedAnything(report)).toBe(false)
    expect(report.unrepairableEntries).toEqual([])
  })
})
