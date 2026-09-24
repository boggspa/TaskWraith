import * as fs from 'node:fs'
import * as path from 'node:path'

/** `chats/` is the Host's domain: HostProfileDomainStore.listThreads() treats
 *  EVERY entry as a chat record and fail-closes on anything that is not an
 *  owner-only `<id>.json` regular file. Two pieces of legacy residue violate
 *  that, and because the external Host is spawned with `stdio: 'ignore'` its
 *  refusal to start is invisible — the app silently falls back to the
 *  in-process Host, whose projection reconciler then re-reads the whole chat
 *  list on a 1s timer in the main process.
 *
 *  1. A `.composer-selections/` directory written inside `chats/` by an older
 *     ChatComposerSelectionOverlayStore, which now lives beside `chats/`.
 *  2. Chat files created before 2026-07-03 at mode 644; every writer has
 *     emitted 0600 since.
 *
 *  This repair is idempotent and additive: it relocates overlay files without
 *  clobbering newer ones, tightens modes, and REPORTS anything it does not
 *  understand rather than deleting it — a silent tidy-up would trade a visible
 *  Host failure for an invisible data loss. */

export const CHAT_FILE_MODE = 0o600
export const LEGACY_OVERLAY_DIRECTORY_NAME = '.composer-selections'

export interface ChatsDirectoryEntry {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface ChatsDirectoryHygieneDeps {
  exists(path: string): boolean
  readdir(path: string): ChatsDirectoryEntry[]
  /** Permission bits, or null when the entry cannot be stat'd. */
  mode(path: string): number | null
  chmod(path: string, mode: number): void
  ensureDir(path: string): void
  /** Must not overwrite an existing destination. */
  rename(from: string, to: string): void
  removeDirectoryIfEmpty(path: string): void
  join(...parts: string[]): string
}

export interface ChatsDirectoryHygieneReport {
  relocatedOverlayFiles: number
  /** Overlay files left behind because the destination already held a copy. */
  overlayConflicts: number
  legacyOverlayDirectoryCleared: boolean
  tightenedFileModes: number
  /** Entries the Host will still reject, which this repair will not touch. */
  unrepairableEntries: string[]
}

const EMPTY_REPORT: ChatsDirectoryHygieneReport = {
  relocatedOverlayFiles: 0,
  overlayConflicts: 0,
  legacyOverlayDirectoryCleared: false,
  tightenedFileModes: 0,
  unrepairableEntries: []
}

/** Mirrors HostProfileDomainStore.safeId. The report promises to name entries
 *  "the Host will still reject", so it has to judge ids by the Host's rule, not
 *  a looser one. */
function safeId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- mirrors the Host predicate.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** Mirrors HostProfileDomainStore.isRecognizedTemp — the Host tolerates these,
 *  so neither may this repair treat them as foreign. */
function isRecognizedTemp(name: string): boolean {
  if (name.startsWith('.') && name.endsWith('.tmp')) return true
  const match = /^(.+)\.json\.(\d+)\.([A-Za-z0-9_-]+)\.tmp$/.exec(name)
  return match !== null && safeId(match[1])
}

export function repairChatsDirectoryForHost(options: {
  chatsDir: string
  overlayDir: string
  deps: ChatsDirectoryHygieneDeps
  /** Mode repair is meaningless on win32, exactly as the Host's own check is. */
  platform?: string
}): ChatsDirectoryHygieneReport {
  const { chatsDir, overlayDir, deps } = options
  const platform = options.platform ?? process.platform
  if (!deps.exists(chatsDir)) return { ...EMPTY_REPORT, unrepairableEntries: [] }

  const report: ChatsDirectoryHygieneReport = { ...EMPTY_REPORT, unrepairableEntries: [] }

  for (const entry of deps.readdir(chatsDir)) {
    const entryPath = deps.join(chatsDir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name !== LEGACY_OVERLAY_DIRECTORY_NAME) {
        report.unrepairableEntries.push(entry.name)
        continue
      }
      deps.ensureDir(overlayDir)
      for (const overlayEntry of deps.readdir(entryPath)) {
        if (!overlayEntry.isFile() || !overlayEntry.name.endsWith('.json')) {
          report.unrepairableEntries.push(deps.join(entry.name, overlayEntry.name))
          continue
        }
        const from = deps.join(entryPath, overlayEntry.name)
        const to = deps.join(overlayDir, overlayEntry.name)
        if (deps.exists(to)) {
          // The relocated store already wrote this chat's overlay. Its copy is
          // newer by construction, so keep it and leave the legacy file for a
          // human rather than destroying either.
          report.overlayConflicts += 1
          // The legacy directory cannot be cleared while this file remains, so
          // the Host stays broken — this has to reach the operator, not sit in
          // a counter no caller reads.
          report.unrepairableEntries.push(deps.join(entry.name, overlayEntry.name))
          continue
        }
        deps.rename(from, to)
        report.relocatedOverlayFiles += 1
      }
      // removeDirectoryIfEmpty refuses a non-empty directory, so a conflict
      // left behind above keeps the legacy directory in place on its own.
      deps.removeDirectoryIfEmpty(entryPath)
      report.legacyOverlayDirectoryCleared = !deps.exists(entryPath)
      continue
    }

    if (!entry.isFile()) {
      // Catches symlinks too: a symlink's Dirent is neither file nor
      // directory. The Host rejects them outright and a repair must not
      // silently resolve or delete one — surface it instead.
      report.unrepairableEntries.push(entry.name)
      continue
    }
    const isChatRecord =
      entry.name.endsWith('.json') && safeId(entry.name.slice(0, -'.json'.length))
    if (!isChatRecord && !isRecognizedTemp(entry.name)) {
      report.unrepairableEntries.push(entry.name)
      continue
    }
    if (platform === 'win32') continue
    const mode = deps.mode(entryPath)
    if (mode === null) {
      report.unrepairableEntries.push(entry.name)
      continue
    }
    if ((mode & 0o077) !== 0) {
      deps.chmod(entryPath, CHAT_FILE_MODE)
      report.tightenedFileModes += 1
    }
  }

  return report
}

export function chatsDirectoryHygieneChangedAnything(report: ChatsDirectoryHygieneReport): boolean {
  return (
    report.relocatedOverlayFiles > 0 ||
    report.tightenedFileModes > 0 ||
    report.legacyOverlayDirectoryCleared
  )
}

/** The production adapter. Kept beside the policy so the composition root wires
 *  one call rather than eight filesystem primitives. */
export function nodeChatsDirectoryHygieneDeps(): ChatsDirectoryHygieneDeps {
  return {
    join: (...parts: string[]) => path.join(...parts),
    exists: (target) => fs.existsSync(target),
    readdir: (target) => fs.readdirSync(target, { withFileTypes: true }),
    mode: (target) => {
      try {
        return fs.lstatSync(target).mode & 0o777
      } catch {
        return null
      }
    },
    chmod: (target, mode) => fs.chmodSync(target, mode),
    ensureDir: (target) => fs.mkdirSync(target, { recursive: true, mode: 0o700 }),
    rename: (from, to) => {
      // renameSync would clobber; the policy promises it never does.
      if (fs.existsSync(to)) throw new Error(`Refusing to overwrite ${to}`)
      fs.renameSync(from, to)
    },
    removeDirectoryIfEmpty: (target) => {
      try {
        fs.rmdirSync(target)
      } catch {
        // Non-empty or already gone — both are fine.
      }
    }
  }
}
