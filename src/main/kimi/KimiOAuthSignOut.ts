// Kimi Code sign-out for the Settings "Sign out" action.
//
// The Kimi Code CLI has no bounded `logout` subcommand (`kimi --help` lists
// `login` only), and launching its interactive TUI just to type `/logout`
// would start an unadmitted provider session. Kimi's own logout is a single
// storage operation — FileTokenStorage.remove(<slot>) unlinks
// `<KIMI_CODE_HOME>/credentials/<slot>.json` — so TaskWraith performs exactly
// that, for exactly the slot config.toml binds the managed provider to. That
// is the file TaskWraith's own "Open Terminal to sign in" (`kimi login`)
// writes and the file every managed seat projects. Nothing else in the Kimi
// home is touched: config.toml, the refresh-lock directory, sessions, and any
// TaskWraith Settings API key all stay as they are.

import { promises as nodeFs } from 'fs'
import { join } from 'path'
import { kimiOAuthCredentialFileName } from '../../shared/kimiOAuthCredentialSlot'

export interface KimiOAuthSignOutFs {
  readFile: (path: string) => Promise<string>
  /** Must not follow a symlink at the checked path. */
  lstat: (path: string) => Promise<{
    isFile: () => boolean
    isSymbolicLink: () => boolean
  }>
  unlink: (path: string) => Promise<void>
}

export type KimiOAuthSignOutResult =
  | { ok: true; removed: boolean; credentialFileName: string }
  | { ok: false; error: string }

const nodeSignOutFs: KimiOAuthSignOutFs = {
  readFile: (path) => nodeFs.readFile(path, 'utf8'),
  lstat: (path) => nodeFs.lstat(path),
  unlink: (path) => nodeFs.unlink(path)
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Remove the managed Kimi Code OAuth token. Idempotent: an already-absent
 * token is a successful sign-out with `removed: false`. Refuses (removing
 * nothing) when config.toml names a slot that is not a plain file name or the
 * slot path is not a regular file.
 */
export async function signOutKimiOAuth(input: {
  sourceHome: string
  fs?: KimiOAuthSignOutFs
}): Promise<KimiOAuthSignOutResult> {
  const fs = input.fs ?? nodeSignOutFs
  let config: string | null = null
  try {
    config = await fs.readFile(join(input.sourceHome, 'config.toml'))
  } catch {
    config = null
  }
  const credentialFileName = kimiOAuthCredentialFileName(config)
  if (!credentialFileName) {
    return {
      ok: false,
      error:
        'Kimi Code config.toml names an OAuth slot TaskWraith does not recognise, so nothing was removed. Sign out from Kimi Code itself.'
    }
  }
  const credentialPath = join(input.sourceHome, 'credentials', credentialFileName)
  try {
    const stat = await fs.lstat(credentialPath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        ok: false,
        error: 'The Kimi Code OAuth credential is not a regular file, so nothing was removed.'
      }
    }
    await fs.unlink(credentialPath)
    return { ok: true, removed: true, credentialFileName }
  } catch (error) {
    if (isMissing(error)) return { ok: true, removed: false, credentialFileName }
    return {
      ok: false,
      error: `Could not remove the Kimi Code OAuth credential: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}
