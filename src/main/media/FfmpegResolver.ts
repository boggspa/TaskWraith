import {
  __resetHostToolResolverCache,
  hostToolMissingError,
  hostToolPath
} from '../HostToolResolver'

/**
 * Resolve the USER-INSTALLED ffmpeg / ffprobe binaries.
 *
 * The discovery logic itself now lives in `src/main/HostToolResolver.ts` — this
 * module is the ffmpeg-shaped adapter over it, kept so the media tool wiring in
 * index.ts keeps its narrow `{ ffmpegPath, ffprobePath }` view. The policy is
 * unchanged and still documented at the source: we never bundle ffmpeg
 * (licensing + the universal-build native-dep ban) and we don't auto-install
 * (auto-download flips the GPL posture). Finder-launched apps don't inherit the
 * shell PATH and /opt/homebrew/bin isn't in the default launchd PATH, so the
 * resolver probes augmented candidate dirs with an explicit X_OK check.
 */

export interface FfmpegBinaries {
  ffmpegPath: string | null
  ffprobePath: string | null
}

/** Resolve the ffmpeg + ffprobe absolute paths. `force` re-probes (e.g. after the
 * user installs ffmpeg mid-session). Caching lives in the host-tool resolver. */
export function resolveFfmpegBinaries(force = false): FfmpegBinaries {
  return {
    ffmpegPath: hostToolPath('ffmpeg', force),
    ffprobePath: hostToolPath('ffprobe', force)
  }
}

/** Actionable capability error for a missing binary — handed to the agent as a
 * recoverable tool error (not thrown), exactly like the other capability gates. */
export function ffmpegMissingError(which: 'ffmpeg' | 'ffprobe'): string {
  return hostToolMissingError(which)
}

/** Test-only: clear the resolver cache. */
export function __resetFfmpegResolverCache(): void {
  __resetHostToolResolverCache()
}
