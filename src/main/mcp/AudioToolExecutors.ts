import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  isTranscriptRasterImageMime,
  isTranscriptSvgMime,
  sniffImageMime
} from '../services/TranscriptMediaService'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from '../services/TranscriptMediaAssetStore'

/**
 * audio_render_wav MCP tool executor — the first "in-house media surface" proving
 * slice (see docs / the media-surfaces investigation).
 *
 * What it does: synthesize a short tone with the Web Audio API (OfflineAudio
 * context), hand-build a 16-bit PCM WAV in pure JS (zero native dep — NOT ffmpeg/
 * sharp, which break the universal build), measure peak/RMS/dBFS, and RENDER a
 * waveform PNG that rides back as a normal inline transcript attachment. The
 * point is to prove the whole pattern end-to-end — headless Web Audio render ->
 * pure-JS encode -> introspection meta -> inline image — on the EXISTING image
 * media spine, without touching the four hard questions (offscreen WebCodecs,
 * screenshot-fps, CSP/cross-origin-isolation, the float-over-DOM editor).
 *
 * Engine split (mirrors ImageToolExecutors / OffscreenImageRenderer): the
 * Electron render lives in AudioRenderEngine; this module is pure logic (engine
 * injected) so it is unit-testable without Electron. The agent supplies ONLY
 * clamped numbers + a fixed-enum waveform — never a script — so this is a
 * parameterized render like svg_rasterize, NOT an eval surface (it does not
 * inherit the canvas_eval lockbox).
 *
 * Security invariant enforced HERE (C2, same as the image tools): the bytes
 * returned to the model are magic-byte-sniffed raster-only on the produced
 * output.
 */

export const AUDIO_MCP_TOOL_NAMES = ['audio_render_wav', 'audio_analyze'] as const
export type AudioMcpToolName = (typeof AUDIO_MCP_TOOL_NAMES)[number]

export function isAudioMcpToolName(name: string): name is AudioMcpToolName {
  return (AUDIO_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

/** Output-canvas dimension ceiling — mirrors the image tools so a waveform can't
 * request a memory-bomb framebuffer. */
export const MAX_AUDIO_DIMENSION = 8192
/** Local mirror of OffscreenImageRenderer.MAX_OFFSCREEN_RENDER_PIXELS — kept here
 * (not imported) so this module stays Electron-free / unit-testable, exactly as
 * ImageToolExecutors does. Caps the rendered AREA. */
export const MAX_AUDIO_RENDER_PIXELS = 24_000_000
/** Hard cap on synthesized audio length. 30s @ 48kHz mono 16-bit ≈ 2.9MB WAV —
 * generous for a "preview a tone / show me its waveform" proving slice while
 * bounding the OfflineAudioContext buffer + the per-sample draw loop. */
export const MAX_AUDIO_DURATION_MS = 30_000
const DEFAULT_DURATION_MS = 1_000
const DEFAULT_FREQUENCY_HZ = 440
const DEFAULT_GAIN = 0.8
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 256
const MIN_DIMENSION = 16

/** Sample rates the Web Audio OfflineAudioContext reliably accepts. Anything else
 * is snapped to 44100 rather than risking a constructor throw mid-render. */
const ALLOWED_SAMPLE_RATES = [8000, 16000, 22050, 32000, 44100, 48000] as const
const DEFAULT_SAMPLE_RATE = 44100

const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const
export type AudioWaveform = (typeof WAVEFORMS)[number]

/** Fully-resolved, clamped render spec handed to the engine. Every field is a
 * vetted primitive — the engine interpolates these into the page via
 * JSON.stringify, so no untrusted text reaches the rendered document. */
export interface AudioRenderSpec {
  sampleRate: number
  frames: number
  durationMs: number
  frequencyHz: number
  waveform: AudioWaveform
  gain: number
  width: number
  height: number
}

/** Introspection the synth surface can give that the "drive the real app" path
 * never could (no live waveform/peak/dBFS off an exported file). */
export interface AudioRenderMeta {
  sampleRate: number
  frames: number
  durationMs: number
  channels: number
  waveform: AudioWaveform
  frequencyHz: number
  gain: number
  peak: number
  rms: number
  peakDbfs: number
  wavByteLength: number
  wavHeaderOk: boolean
}

/** Target number of waveform buckets harvested from the offscreen analysis pass.
 * 256 is plenty for a crisp inline DAW strip while staying compact (~700 bytes JSON). */
export const AUDIO_PEAKS_TARGET_BUCKETS = 256
/** HARD cap on the harvested peaks array length. The page is asked for
 * AUDIO_PEAKS_TARGET_BUCKETS, but main-side validation re-clamps to this ceiling so a
 * malformed/oversized page result can never bloat the ref or the iOS projection. */
export const AUDIO_PEAKS_MAX_BUCKETS = 512

/**
 * PURE main-side validator for the waveform peaks harvested from the offscreen page.
 * The page is OUR script, but it runs in a browser context, so we re-validate its
 * output before trusting it onto a ref: every bucket is coerced to an integer in
 * 0..255 (non-finite → 0), and the array is HARD-capped at AUDIO_PEAKS_MAX_BUCKETS.
 * Returns undefined for a non-array / empty input so the ref simply omits `peaks`
 * (the poster JPEG fallback kicks in). Never throws.
 */
export function normalizeHarvestedPeaks(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const capped = raw.length > AUDIO_PEAKS_MAX_BUCKETS ? raw.slice(0, AUDIO_PEAKS_MAX_BUCKETS) : raw
  const out: number[] = []
  for (const value of capped) {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) {
      out.push(0)
      continue
    }
    out.push(clamp(Math.round(n), 0, 255))
  }
  return out.length > 0 ? out : undefined
}

/** A real audio file, decoded + measured by the offscreen Web Audio engine.
 * This is the introspection the "drive the real app" path can never give —
 * peak/RMS/dBFS/clipping/silence off the actual samples, not an exported file. */
export interface AudioAnalysisMeta {
  durationMs: number
  analysisSampleRate: number
  channels: number
  frames: number
  peak: number
  peakDbfs: number
  rms: number
  rmsDbfs: number
  clippedSamples: number
  clippedPercent: number
  silencePercent: number
  /**
   * Compact waveform envelope — N integer buckets (target 256, hard-cap 512), each
   * 0–255 = round(maxAbsSampleInBucket * 255). Built in the SAME offscreen pass that
   * paints the waveform PNG (reuses the already-decoded channel data — no second
   * decode). Absent if the page couldn't produce it; the host re-validates via
   * normalizeHarvestedPeaks before putting it on a ref.
   */
  peaks?: number[]
}

/** Decoder input: the audio bytes (base64) + the sniffed container + the canvas
 * dims for the waveform. Bytes are passed to the page out-of-band (not embedded
 * in the page HTML) to dodge the data:-URL size ceiling. */
export interface AudioAnalysisInput {
  dataBase64: string
  mimeType: string
  width: number
  height: number
}

export interface AudioEngine {
  renderWaveformPng(spec: AudioRenderSpec): Promise<{ png: Buffer; meta: AudioRenderMeta }>
  analyzeAudio(input: AudioAnalysisInput): Promise<{ png: Buffer; meta: AudioAnalysisMeta }>
}

export type ResolvedAudioSource =
  | { ok: true; dataBase64: string; mimeType: string; byteLength: number }
  | { ok: false; reason: string }

export interface AudioToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export interface AudioToolExecutors {
  executeAudioTool: (
    toolName: AudioMcpToolName,
    rawArgs: unknown,
    ctx: AudioToolContext
  ) => Promise<McpToolExecutionResult>
}

export interface AudioToolExecutorDeps {
  engine: AudioEngine
  /** Resolve an audio source (sourcePath inside the workspace) to bytes. */
  resolveAudioSource: (
    args: Record<string, unknown>,
    ctx: AudioToolContext
  ) => Promise<ResolvedAudioSource>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numArg(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function snapSampleRate(value: number | null): number {
  if (value === null) return DEFAULT_SAMPLE_RATE
  let best = DEFAULT_SAMPLE_RATE
  let bestDelta = Infinity
  for (const rate of ALLOWED_SAMPLE_RATES) {
    const delta = Math.abs(rate - value)
    if (delta < bestDelta) {
      bestDelta = delta
      best = rate
    }
  }
  return best
}

function resolveWaveform(value: unknown): AudioWaveform {
  const raw = String(value ?? '').trim().toLowerCase()
  return (WAVEFORMS as readonly string[]).includes(raw) ? (raw as AudioWaveform) : 'sine'
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

/** Wrap a produced PNG into a tool result AFTER the C2 output sniff, merging the
 * tool's introspection meta (waveform stats, or decode analysis) into the text
 * payload. Shared by audio_render_wav and audio_analyze. */
function imageBlockResult(
  toolName: string,
  extraMeta: Record<string, unknown>,
  png: Buffer
): McpToolExecutionResult {
  const sniffed = sniffImageMime(png)
  if (!isTranscriptRasterImageMime(sniffed) || isTranscriptSvgMime(sniffed)) {
    return fail(toolName, 'internal error: produced output was not a raster image')
  }
  if (png.byteLength > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES) {
    return fail(
      toolName,
      `output image is too large (${png.byteLength} bytes; max ${TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES}). Reduce width/height.`
    )
  }
  const full = {
    ...extraMeta,
    ok: true,
    tool: toolName,
    mimeType: 'image/png',
    byteLength: png.byteLength
  }
  const text = JSON.stringify(full)
  const block: McpToolContentBlock = {
    type: 'image',
    mimeType: 'image/png',
    data: png.toString('base64')
  }
  return { text, structuredContent: full, content: [{ type: 'text', text }, block] }
}

/** Clamp output-canvas dimensions + enforce the framebuffer-area budget. */
function resolveDims(args: Record<string, unknown>): { width: number; height: number } | { error: string } {
  const width = clamp(
    Math.round(numArg(args.width ?? args.w) ?? DEFAULT_WIDTH),
    MIN_DIMENSION,
    MAX_AUDIO_DIMENSION
  )
  const height = clamp(
    Math.round(numArg(args.height ?? args.h) ?? DEFAULT_HEIGHT),
    MIN_DIMENSION,
    MAX_AUDIO_DIMENSION
  )
  if (width * height > MAX_AUDIO_RENDER_PIXELS) {
    return {
      error: `waveform too large (${width}×${height} = ${width * height}px; max ${MAX_AUDIO_RENDER_PIXELS}px). Reduce width/height.`
    }
  }
  return { width, height }
}

/** Resolve raw tool args into a clamped, safe render spec. Returns an error
 * string only for genuinely unusable input; everything else is clamped to a
 * sane range so the agent gets a render rather than a rejection. */
function resolveSpec(args: Record<string, unknown>): AudioRenderSpec | { error: string } {
  const sampleRate = snapSampleRate(numArg(args.sampleRate))
  const durationMs = clamp(
    Math.round(numArg(args.durationMs) ?? DEFAULT_DURATION_MS),
    1,
    MAX_AUDIO_DURATION_MS
  )
  // Frequency is bounded by Nyquist for the chosen rate so a 19kHz tone at 8kHz
  // doesn't alias into nonsense.
  const nyquist = Math.floor(sampleRate / 2)
  const frequencyHz = clamp(
    numArg(args.frequencyHz ?? args.frequency) ?? DEFAULT_FREQUENCY_HZ,
    1,
    Math.min(20000, nyquist - 1)
  )
  const waveform = resolveWaveform(args.waveform ?? args.type)
  const gain = clamp(numArg(args.gain) ?? DEFAULT_GAIN, 0, 1)
  const width = clamp(
    Math.round(numArg(args.width ?? args.w) ?? DEFAULT_WIDTH),
    MIN_DIMENSION,
    MAX_AUDIO_DIMENSION
  )
  const height = clamp(
    Math.round(numArg(args.height ?? args.h) ?? DEFAULT_HEIGHT),
    MIN_DIMENSION,
    MAX_AUDIO_DIMENSION
  )
  if (width * height > MAX_AUDIO_RENDER_PIXELS) {
    return {
      error: `waveform too large (${width}×${height} = ${width * height}px; max ${MAX_AUDIO_RENDER_PIXELS}px). Reduce width/height.`
    }
  }
  const frames = Math.max(1, Math.round((sampleRate * durationMs) / 1000))
  return { sampleRate, frames, durationMs, frequencyHz, waveform, gain, width, height }
}

export function createAudioToolExecutors(deps: AudioToolExecutorDeps): AudioToolExecutors {
  const { engine, resolveAudioSource } = deps

  async function executeRenderWav(
    args: Record<string, unknown>,
    _ctx: AudioToolContext
  ): Promise<McpToolExecutionResult> {
    const spec = resolveSpec(args)
    if ('error' in spec) return fail('audio_render_wav', spec.error)
    try {
      const { png, meta } = await engine.renderWaveformPng(spec)
      return imageBlockResult('audio_render_wav', { ...meta }, png)
    } catch (error) {
      return fail('audio_render_wav', error instanceof Error ? error.message : String(error))
    }
  }

  async function executeAnalyze(
    args: Record<string, unknown>,
    ctx: AudioToolContext
  ): Promise<McpToolExecutionResult> {
    const dims = resolveDims(args)
    if ('error' in dims) return fail('audio_analyze', dims.error)
    const source = await resolveAudioSource(args, ctx)
    if (!source.ok) return fail('audio_analyze', `could not read audio: ${source.reason}`)
    try {
      const { png, meta } = await engine.analyzeAudio({
        dataBase64: source.dataBase64,
        mimeType: source.mimeType,
        width: dims.width,
        height: dims.height
      })
      return imageBlockResult(
        'audio_analyze',
        { ...meta, sourceMimeType: source.mimeType, sourceBytes: source.byteLength },
        png
      )
    } catch (error) {
      return fail('audio_analyze', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    executeAudioTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      if (toolName === 'audio_render_wav') return executeRenderWav(args, ctx)
      if (toolName === 'audio_analyze') return executeAnalyze(args, ctx)
      return Promise.resolve(fail(String(toolName), `unknown audio tool "${toolName}"`))
    }
  }
}
