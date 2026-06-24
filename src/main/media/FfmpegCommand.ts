import path from 'path'

/**
 * PURE (zero-IO, Electron-free) ffmpeg/ffprobe COMMAND builder — the security core
 * of the S1 ffmpeg integration. The agent never contributes flag tokens: it picks
 * a typed INTENT + numeric params, and this module maps it to a FIXED argv template
 * (the Jellyfin CVE-2023-49096 / CVE-2025-31499 class is argument injection, which
 * argv+shell:false does NOT stop — so we allow-list intents, never blocklist flags).
 *
 * Hard rules baked into every command:
 *  - `-protocol_whitelist file` (kills http:/concat:/subfile: SSRF + arbitrary-file
 *    read via a crafted "filename"), `-nostdin`, `-y`, quiet logging.
 *  - every path is shape-validated here (absolute, no leading `-`, no null byte) AND
 *    realpath-jailed by the caller before it reaches argv.
 *  - all numeric params are clamped + stringified; no agent string ever becomes a token
 *    except the two validated absolute paths.
 */

export type AudioOutFormat = 'wav' | 'm4a' | 'mp3'

export type FfmpegIntent =
  | { kind: 'extract_audio'; inputPath: string; outputPath: string; format: AudioOutFormat; bitrateKbps?: number }
  | { kind: 'transcode_audio'; inputPath: string; outputPath: string; format: AudioOutFormat; bitrateKbps?: number }
  | { kind: 'transcode_video'; inputPath: string; outputPath: string; crf?: number; scaleWidth?: number; fps?: number }
  | { kind: 'thumbnail'; inputPath: string; outputPath: string; atMs?: number; width?: number }

export type FfmpegArgsResult = { ok: true; args: string[] } | { ok: false; error: string }

/** Shape-validate a path that will become an ffmpeg argv token. The realpath
 * jail (under the workspace / staging dir) is the CALLER's job; this is the
 * defense-in-depth option-injection guard. */
export function assertSafeMediaArgPath(p: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, error: 'path is empty' }
  if (p.includes('\0')) return { ok: false, error: 'path contains a null byte' }
  // Leading '-' would be parsed by ffmpeg as an option, not a filename — the core
  // of the argument-injection class. A realpath under /Users|/tmp|… never starts with '-'.
  if (p.startsWith('-')) return { ok: false, error: 'path may not start with "-"' }
  if (!path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' }
  return { ok: true, path: p }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// Even width for the scaler (`-2` keeps aspect + even height, required by yuv420p).
function evenWidth(w: number): number {
  return w % 2 === 0 ? w : w - 1
}

const BITRATE_MIN = 32
const BITRATE_MAX = 320
const BITRATE_DEFAULT = 192
const CRF_MIN = 0
const CRF_MAX = 51
const CRF_DEFAULT = 23
const SCALE_MIN = 16
const SCALE_MAX = 4096
const FPS_MIN = 1
const FPS_MAX = 120

/** Global + input opts shared by every command; `-protocol_whitelist file` and
 * `-y` must precede `-i`. */
const GLOBAL_OPTS = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y']

function audioCodecArgs(format: AudioOutFormat, bitrateKbps?: number): string[] {
  const kbps = clampInt(bitrateKbps, BITRATE_MIN, BITRATE_MAX, BITRATE_DEFAULT)
  switch (format) {
    case 'wav':
      return ['-c:a', 'pcm_s16le'] // lossless, bitrate irrelevant
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', `${kbps}k`]
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`]
  }
}

export function buildFfmpegArgs(intent: FfmpegIntent): FfmpegArgsResult {
  const input = assertSafeMediaArgPath(intent.inputPath)
  if (!input.ok) return { ok: false, error: `input ${input.error}` }
  const output = assertSafeMediaArgPath(intent.outputPath)
  if (!output.ok) return { ok: false, error: `output ${output.error}` }

  // Input-side opts (precede -i). Thumbnail seeks here (fast input seek).
  const inputOpts: string[] = ['-protocol_whitelist', 'file']
  if (intent.kind === 'thumbnail' && intent.atMs !== undefined) {
    const atSec = clampInt(intent.atMs, 0, 24 * 60 * 60 * 1000, 0) / 1000
    inputOpts.push('-ss', String(atSec))
  }

  let outputOpts: string[]
  switch (intent.kind) {
    case 'extract_audio':
      outputOpts = ['-vn', ...audioCodecArgs(intent.format, intent.bitrateKbps)]
      break
    case 'transcode_audio':
      outputOpts = ['-map', '0:a:0', ...audioCodecArgs(intent.format, intent.bitrateKbps)]
      break
    case 'transcode_video': {
      const crf = clampInt(intent.crf, CRF_MIN, CRF_MAX, CRF_DEFAULT)
      // Software libx264 (CRF works; VT hardware encode — where -crf is silently
      // ignored — is the daemon's job in S3). +faststart for web/<video> seeking.
      outputOpts = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf)]
      if (intent.scaleWidth !== undefined) {
        const w = evenWidth(clampInt(intent.scaleWidth, SCALE_MIN, SCALE_MAX, 1280))
        outputOpts.push('-vf', `scale=${w}:-2`)
      }
      if (intent.fps !== undefined) {
        outputOpts.push('-r', String(clampInt(intent.fps, FPS_MIN, FPS_MAX, 30)))
      }
      outputOpts.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart')
      break
    }
    case 'thumbnail': {
      outputOpts = ['-frames:v', '1']
      if (intent.width !== undefined) {
        const w = evenWidth(clampInt(intent.width, SCALE_MIN, SCALE_MAX, 640))
        outputOpts.push('-vf', `scale=${w}:-2`)
      }
      break
    }
    default: {
      // Exhaustiveness — a new intent kind must extend this switch.
      const _never: never = intent
      return { ok: false, error: `unsupported ffmpeg intent: ${JSON.stringify(_never)}` }
    }
  }

  return { ok: true, args: [...GLOBAL_OPTS, ...inputOpts, '-i', input.path, ...outputOpts, output.path] }
}

/** ffprobe args for JSON stream/format analysis. `-protocol_whitelist file`
 * applies here too (a crafted concat/playlist input must not be followed). */
export function buildFfprobeArgs(inputPath: string): FfmpegArgsResult {
  const input = assertSafeMediaArgPath(inputPath)
  if (!input.ok) return { ok: false, error: `input ${input.error}` }
  return {
    ok: true,
    args: [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-protocol_whitelist',
      'file',
      input.path
    ]
  }
}
