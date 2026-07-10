import { constants as fsConstants, promises as fs } from 'fs'
import { dirname, join } from 'path'

export const CODEX_CODE_MODE_HOST_ENV = 'CODEX_CODE_MODE_HOST_PATH'

export const KNOWN_MACOS_CODE_MODE_HOST_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host',
  '/Applications/Codex.app/Contents/Resources/codex-code-mode-host'
] as const

function codeModeHostBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
}

async function executableFileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return false
    await fs.access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the optional V8 companion used by Codex's code-mode tool. Standalone
 * CLI distributions can expose code mode without shipping the companion next
 * to the `codex` executable, while the macOS apps do bundle it. Codex supports
 * an explicit CODEX_CODE_MODE_HOST_PATH override for this split-install case.
 */
export async function resolveCodexCodeModeHostPath(
  codexBinaryPath: string,
  fallbackCandidates: readonly string[] = process.platform === 'darwin'
    ? KNOWN_MACOS_CODE_MODE_HOST_PATHS
    : []
): Promise<string | null> {
  const hostBinaryName = codeModeHostBinaryName()
  const candidates = [join(dirname(codexBinaryPath), hostBinaryName)]

  try {
    const realCodexPath = await fs.realpath(codexBinaryPath)
    candidates.push(join(dirname(realCodexPath), hostBinaryName))
  } catch {
    // The caller already validated the Codex binary. A failed realpath only
    // means we cannot inspect the target directory of a symlink here.
  }

  candidates.push(...fallbackCandidates)
  for (const candidate of new Set(candidates)) {
    if (await executableFileExists(candidate)) return candidate
  }
  return null
}

export async function withCodexCodeModeHostEnv(
  env: Record<string, string>,
  codexBinaryPath: string,
  fallbackCandidates?: readonly string[]
): Promise<Record<string, string>> {
  if (env[CODEX_CODE_MODE_HOST_ENV]) return env
  const hostPath = await resolveCodexCodeModeHostPath(codexBinaryPath, fallbackCandidates)
  if (!hostPath) return env
  return { ...env, [CODEX_CODE_MODE_HOST_ENV]: hostPath }
}
