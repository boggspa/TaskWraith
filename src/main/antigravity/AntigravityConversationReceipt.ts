// Conversation-resume receipt for the official, user-installed `agy` CLI.
//
// `agy --print` emits no structured session id on stdout, so the only way to
// learn the conversation it used is the CLI's own cache file:
//
//   ~/.gemini/antigravity-cli/cache/last_conversations.json
//   { "<workspace cwd>": "<conversation uuid>", ... }
//
// This is a deliberately MINIMAL surface. It reads that one JSON map and takes a
// single uuid for one workspace path. It does NOT read `brain/<conv>/…
// transcript.jsonl`, install an `agy` plugin, or register hooks — the richer
// route other harnesses take to capture turn events. Resumption only needs the
// id, so nothing else is touched.
//
// Verified against agy on 2026-07-25:
//   - `--conversation <known-id>` with `-p` resumes and recalls prior context.
//   - `--conversation <unknown-id>` is SILENTLY IGNORED: agy allocates a fresh
//     conversation and reports no error. A stale or foreign id therefore costs
//     context with no diagnostic, which is why the receipt is re-read after
//     EVERY turn (the id agy actually used wins over the one we requested) and
//     why `normalizeAgyConversationId` rejects anything that is not a uuid.
//   - Passing no `--conversation` always starts a fresh conversation; it never
//     implicitly inherits an existing one for the same cwd. So a first turn
//     needs no `--new-project` guard to stay isolated.

import { promises as fsPromises } from 'fs'
import os from 'os'
import { join } from 'path'
import { normalizeAgyConversationId } from './AntigravityCli'

export interface AgyConversationReceiptDependencies {
  readFile?: (path: string) => Promise<string>
  realpath?: (path: string) => Promise<string>
  homeDir?: string
  env?: Readonly<Record<string, string | undefined>>
}

function expandHomePath(value: string, homeDir: string): string {
  return value.startsWith('~') ? join(homeDir, value.slice(1)) : value
}

/**
 * Mirrors `geminiCliRootPath()` in ProviderAuthUsage: the same `GEMINI_CLI_HOME`
 * / `GEMINI_HOME` overrides decide where `.gemini` lives. Honouring them matters
 * because `createAgyCliEnv` strips only credential keys — a user override
 * reaches the agy child, so reading a hard-coded `~/.gemini` would silently
 * never find the receipt and resumption would degrade to "always fresh".
 */
export function agyCliRootPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir()
): string {
  const configuredHome = env.GEMINI_CLI_HOME
  if (configuredHome && configuredHome.trim()) {
    return join(expandHomePath(configuredHome.trim(), homeDir), '.gemini')
  }
  const configuredRoot = env.GEMINI_HOME
  return configuredRoot && configuredRoot.trim()
    ? expandHomePath(configuredRoot.trim(), homeDir)
    : join(homeDir, '.gemini')
}

export function agyConversationReceiptPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir()
): string {
  return join(agyCliRootPath(env, homeDir), 'antigravity-cli', 'cache', 'last_conversations.json')
}

/**
 * Candidate lookup keys for one workspace, most-exact first. macOS resolves
 * `/tmp` to `/private/tmp`, and agy records the cwd it actually ran in, so a
 * symlinked workspace needs the resolved path tried too.
 */
export function agyConversationReceiptCandidateKeys(
  workspacePath: string,
  resolvedPath?: string | null
): string[] {
  const candidates: string[] = []
  const add = (value: string | null | undefined): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }
  const withoutTrailingSlash = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.replace(/\/+$/, '') : value

  add(workspacePath)
  add(withoutTrailingSlash(workspacePath || ''))
  add(resolvedPath)
  add(resolvedPath ? withoutTrailingSlash(resolvedPath) : null)
  return candidates
}

/** Pure half: given the raw file and candidate keys, pick the conversation id. */
export function parseAgyConversationReceipt(
  raw: string,
  candidateKeys: readonly string[]
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const map = parsed as Record<string, unknown>
  for (const key of candidateKeys) {
    const candidate = normalizeAgyConversationId(map[key])
    if (candidate) return candidate
  }
  return null
}

/**
 * Best-effort: every failure (missing file, unreadable, malformed JSON, no entry
 * for this workspace) yields null, which leaves the chat on its previous id and
 * simply means the NEXT turn starts a fresh conversation. Never throws into the
 * run's terminal path.
 */
export async function readAgyConversationReceipt(
  workspacePath: string | null | undefined,
  deps: AgyConversationReceiptDependencies = {}
): Promise<string | null> {
  const workspace = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  if (!workspace) return null

  const readFile = deps.readFile ?? ((path: string) => fsPromises.readFile(path, 'utf8'))
  const realpath = deps.realpath ?? ((path: string) => fsPromises.realpath(path))
  const homeDir = deps.homeDir ?? os.homedir()
  const env = deps.env ?? process.env

  let resolvedPath: string | null = null
  try {
    resolvedPath = await realpath(workspace)
  } catch {
    resolvedPath = null
  }

  try {
    const raw = await readFile(agyConversationReceiptPath(env, homeDir))
    return parseAgyConversationReceipt(
      raw,
      agyConversationReceiptCandidateKeys(workspace, resolvedPath)
    )
  } catch {
    return null
  }
}
