import fs from 'fs'
import path from 'path'
import { cliBinaryNameCandidates, getCliSearchDirs } from '../providers/CliProviderRuntime'

/**
 * Resolve the USER-INSTALLED ffmpeg / ffprobe binaries. We never bundle ffmpeg
 * (licensing + the universal-build native-dep ban) and we don't auto-install
 * (auto-download flips the GPL posture). Finder-launched apps don't inherit the
 * shell PATH and /opt/homebrew/bin isn't in the default launchd PATH, so we probe
 * the same augmented candidate dirs the CLI-provider resolver uses, with an
 * explicit X_OK (executable) check.
 */

export interface FfmpegBinaries {
  ffmpegPath: string | null
  ffprobePath: string | null
}

function findExecutable(name: string): string | null {
  const names = cliBinaryNameCandidates(name) // adds `.exe` etc. on Windows
  for (const dir of getCliSearchDirs()) {
    if (!dir) continue
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        const stat = fs.statSync(candidate)
        if (stat.isFile() || stat.isSymbolicLink()) return candidate
      } catch {
        // absent here / not executable — keep looking
      }
    }
  }
  return null
}

let cached: FfmpegBinaries | null = null

/** Resolve (and cache) the ffmpeg + ffprobe absolute paths. `force` re-probes
 * (e.g. after the user installs ffmpeg mid-session). */
export function resolveFfmpegBinaries(force = false): FfmpegBinaries {
  if (cached && !force) return cached
  cached = { ffmpegPath: findExecutable('ffmpeg'), ffprobePath: findExecutable('ffprobe') }
  return cached
}

/** Actionable capability error for a missing binary — handed to the agent as a
 * recoverable tool error (not thrown), exactly like the other capability gates. */
export function ffmpegMissingError(which: 'ffmpeg' | 'ffprobe'): string {
  return (
    `${which} was not found. Install it (e.g. \`brew install ffmpeg\`) and make sure it is on PATH. ` +
    `TaskWraith looks in /opt/homebrew/bin, /usr/local/bin, /opt/local/bin, and your PATH.`
  )
}

/** Test-only: clear the resolver cache. */
export function __resetFfmpegResolverCache(): void {
  cached = null
}
