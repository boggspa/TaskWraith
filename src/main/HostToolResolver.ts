import fs from 'fs'
import path from 'path'
import { cliBinaryNameCandidates, getCliSearchDirs } from './providers/CliSearchDirs'

/**
 * Resolution + presence reporting for OPTIONAL, USER-INSTALLED host binaries.
 *
 * Why this exists: before this module the repo had three parallel discovery
 * mechanisms that did not interoperate — `resolveCliProviderBinary`
 * (provider-CLI shaped, stat-only, no executable-bit check), `FfmpegResolver`'s
 * private `findExecutable` (the only one that probed X_OK correctly), and
 * `TailscaleDetector`'s hardcoded app-bundle/brew locations — plus a dozen bare
 * `spawn('git'|'rg'|'sqlite3')` calls with no presence check at all. Every new
 * external tool grew its own dir list, so tools resolved under `npm run dev`
 * (which inherits the shell PATH) and silently failed in the packaged app
 * (Finder-launched apps get the minimal launchd PATH, which has no
 * /opt/homebrew/bin). This is that one layer.
 *
 * Policy, inherited from the ffmpeg precedent (docs/audio-video-pipeline-design.md §6):
 * we never bundle these, and we never auto-install them (auto-download would
 * flip the licensing posture we deliberately hold). A missing tool is a
 * RECOVERABLE capability gap — surfaced to the agent as a tool error carrying an
 * install hint, and to the user via the native-capability snapshot — never a throw.
 *
 * NOTE on the non-sandboxed posture: user-installed tools work only because the
 * app is hardened-runtime but NOT App Sandbox (build/entitlements.mac.plist has
 * no com.apple.security.app-sandbox). A sandboxed app cannot exec a binary in
 * /opt/homebrew/bin (EPERM). If document conversion is ever moved inside the
 * provider containment sandbox, that profile must permit exec of the resolved
 * path or every tool here goes dark.
 */

export type HostToolId = 'ffmpeg' | 'ffprobe' | 'pdftoppm' | 'pdftotext'

export interface HostToolDescriptor {
  /** Binary name probed on PATH (Windows PATHEXT variants are added by the resolver). */
  binaryName: string
  /** Human label for the settings/diagnostics surface. */
  label: string
  /** What degrades when this is absent — shown to the user, not just the agent. */
  purpose: string
  /** Actionable install instruction. Kept per-tool so the message names the real package. */
  installHint: string
}

export interface HostToolPresence {
  available: boolean
  /** Absolute path to the resolved binary, when present. */
  path?: string
  /** Why it is unavailable — mirrors NativeFeatureCapability.reason. */
  reason?: string
}

export type HostToolSnapshot = Record<HostToolId, HostToolPresence>

/**
 * The registry. `pdftoppm` and `pdftotext` both ship in poppler, so they share an
 * install hint — worth knowing, because pdftoppm is ALREADY load-bearing for
 * PdfAttachmentRenderService (it rasterizes attached PDFs and falls back to
 * `sips`), it just had no presence reporting until now.
 */
export const HOST_TOOLS: Record<HostToolId, HostToolDescriptor> = {
  ffmpeg: {
    binaryName: 'ffmpeg',
    label: 'ffmpeg',
    purpose: 'Media transcode, audio extraction, and video thumbnails.',
    installHint: 'brew install ffmpeg'
  },
  ffprobe: {
    binaryName: 'ffprobe',
    label: 'ffprobe',
    purpose: 'Media inspection (codec, duration, dimensions, HDR).',
    installHint: 'brew install ffmpeg'
  },
  pdftoppm: {
    binaryName: 'pdftoppm',
    label: 'pdftoppm (poppler)',
    purpose: 'Renders attached PDF pages to images. Without it TaskWraith falls back to `sips`, which is lower fidelity.',
    installHint: 'brew install poppler'
  },
  pdftotext: {
    binaryName: 'pdftotext',
    label: 'pdftotext (poppler)',
    purpose: 'Extracts the text layer from PDFs so agents can read past the rasterized page limit.',
    installHint: 'brew install poppler'
  }
}

export const HOST_TOOL_IDS = Object.keys(HOST_TOOLS) as HostToolId[]

/**
 * Probe a binary across the augmented candidate dirs with a real executable-bit
 * check. Lifted (unchanged in behaviour) out of FfmpegResolver, where it was
 * private and therefore un-reusable — that privacy is the direct cause of the
 * duplicate resolver in PdfAttachmentRenderService.
 *
 * Deliberately keeps FfmpegResolver's X_OK + isFile/isSymbolicLink check rather
 * than resolveCliProviderBinary's stat-only `fileExists`: a non-executable file
 * named `ffmpeg` on PATH must not resolve.
 */
export function findExecutableOnHost(name: string): string | null {
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

/**
 * Module-singleton cache. This matters: getNativeCapabilitySnapshot() runs on
 * every renderer IPC request, so an uncached probe would put a full candidate-dir
 * × PATHEXT stat sweep on a hot path. Probe once, reuse; `force` re-probes after
 * the user installs something mid-session so they don't have to restart.
 */
let cached: Partial<Record<HostToolId, HostToolPresence>> = {}

function probe(id: HostToolId): HostToolPresence {
  const descriptor = HOST_TOOLS[id]
  const resolved = findExecutableOnHost(descriptor.binaryName)
  if (resolved) return { available: true, path: resolved }
  return { available: false, reason: hostToolMissingError(id) }
}

/** Resolve (and cache) one host tool. `force` re-probes. */
export function resolveHostTool(id: HostToolId, force = false): HostToolPresence {
  const hit = cached[id]
  if (hit && !force) return hit
  const presence = probe(id)
  cached[id] = presence
  return presence
}

/** Absolute path for a host tool, or null when absent — the ergonomic accessor. */
export function hostToolPath(id: HostToolId, force = false): string | null {
  return resolveHostTool(id, force).path ?? null
}

/** Presence for every registered tool. Feeds the native-capability snapshot. */
export function getHostToolSnapshot(force = false): HostToolSnapshot {
  const snapshot = {} as HostToolSnapshot
  for (const id of HOST_TOOL_IDS) snapshot[id] = resolveHostTool(id, force)
  return snapshot
}

/**
 * Actionable capability error for a missing binary — handed to the agent as a
 * recoverable tool error (not thrown), exactly like the other capability gates.
 */
export function hostToolMissingError(id: HostToolId): string {
  const descriptor = HOST_TOOLS[id]
  return (
    `${descriptor.binaryName} was not found. Install it (e.g. \`${descriptor.installHint}\`) and make sure it is on PATH. ` +
    `TaskWraith looks in /opt/homebrew/bin, /usr/local/bin, /opt/local/bin, and your PATH.`
  )
}

/** Test-only: clear the resolver cache. */
export function __resetHostToolResolverCache(): void {
  cached = {}
}
