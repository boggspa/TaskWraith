import { resolve } from 'node:path'
import type { AppSettings } from './store/types'

/**
 * Per-workspace "Full Workspace Access" opt-in.
 *
 * A workspace whose path is on `settings.fullWorkspaceAccessPaths` grants its
 * agents the `full_access` posture on non-plan runs: shell/file auto-allow and
 * (via `isFullShellAccessGranted` + `codexSandboxForMode`) Codex
 * `danger-full-access` so the agent can reach the login keychain, ~/Library and
 * paths outside the repo to archive / notarize / upload.
 *
 * This is the ONLY persistent path to a standing full-access grant, and it is
 * DEFAULT-EMPTY: no workspace is elevated unless the user (Mac Settings) or an
 * allow-listed iOS device explicitly opts it in. The main process is the trust
 * root — the compose path resolves + HMAC-signs the resulting posture, so the
 * flag can never be an unsigned renderer/remote escalation (the clamp would
 * force read_only). The global `shellCommands: 'deny'` kill-switch still wins
 * over it (see `preserveExplicitDeny` / `isFullShellAccessGranted`).
 *
 * Deliberately Electron/AppStore-free so it unit-tests under plain vitest.
 */

export function normalizeWorkspaceAccessPath(path: string | null | undefined): string {
  const raw = String(path || '').trim()
  if (!raw) return ''
  try {
    return resolve(raw)
  } catch {
    return raw
  }
}

/** Sanitize the stored list: absolute, de-duplicated, non-empty paths. */
export function normalizeFullWorkspaceAccessPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const normalized = normalizeWorkspaceAccessPath(entry)
    if (normalized) seen.add(normalized)
  }
  return [...seen]
}

export function isWorkspaceFullAccessEnabled(
  settings: Pick<AppSettings, 'fullWorkspaceAccessPaths'> | null | undefined,
  workspacePath: string | null | undefined
): boolean {
  const target = normalizeWorkspaceAccessPath(workspacePath)
  if (!target) return false
  const list = settings?.fullWorkspaceAccessPaths
  if (!Array.isArray(list)) return false
  return list.some((entry) => normalizeWorkspaceAccessPath(entry) === target)
}

/** Add a workspace path to the full-access set (returns a new, normalized list). */
export function withWorkspaceFullAccess(
  current: string[] | null | undefined,
  workspacePath: string
): string[] {
  return normalizeFullWorkspaceAccessPaths([...(current || []), workspacePath])
}

/** Remove a workspace path from the full-access set (returns a new, normalized list). */
export function withoutWorkspaceFullAccess(
  current: string[] | null | undefined,
  workspacePath: string
): string[] {
  const target = normalizeWorkspaceAccessPath(workspacePath)
  return normalizeFullWorkspaceAccessPaths(current).filter((entry) => entry !== target)
}
