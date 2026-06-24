import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  isTranscriptRasterImageMime,
  isTranscriptSvgMime,
  sniffImageMime
} from '../services/TranscriptMediaService'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from '../services/TranscriptMediaAssetStore'

/**
 * image_generate (text -> image via a paid API). Kept separate from the local
 * image_edit/svg_rasterize executors because it has a different trust profile:
 * NETWORK EGRESS carrying a stored API key + the agent's prompt.
 *
 * This module is pure logic — the actual egress (`generate`) and config
 * (`getConfig`, reading the safeStorage-encrypted key + enabled flag) are
 * injected, so the OFF-by-default gating + C2 output sniff are unit-testable
 * without network or Electron. Security invariants enforced HERE:
 *  - DEFAULT OFF: refuses unless config.enabled AND a key for the provider is
 *    configured (the key never leaves `generate`; it is never returned/logged);
 *  - C2: the produced bytes are magic-byte-sniffed raster-only before returning;
 *  - bounded output size.
 * The injected `generate` is responsible for: allowlisted endpoint only, key in
 * the Authorization header (never argv), and SSRF-guarding any image URL it
 * fetches.
 */

export const IMAGE_GEN_TOOL_NAMES = ['image_generate'] as const
export type ImageGenToolName = (typeof IMAGE_GEN_TOOL_NAMES)[number]

export function isImageGenMcpToolName(name: string): name is ImageGenToolName {
  return name === 'image_generate'
}

/**
 * Parse an OpenAI-/xAI-shaped images response (`{ data: [{ b64_json | url }] }`).
 * Prefer inline base64; a `url` is returned only as a fallback (the caller must
 * SSRF-guard + size-cap any URL fetch). Pure + provider-agnostic for testing.
 */
export function parseImageGenResponse(
  json: unknown
): { ok: true; b64?: string; url?: string } | { ok: false; reason: string } {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'invalid response body' }
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, reason: 'response had no image data' }
  }
  const first = data[0] as { b64_json?: unknown; url?: unknown } | null
  if (first && typeof first.b64_json === 'string' && first.b64_json) {
    return { ok: true, b64: first.b64_json }
  }
  if (first && typeof first.url === 'string' && first.url) {
    return { ok: true, url: first.url }
  }
  return { ok: false, reason: 'response had no b64_json or url' }
}

export type ImageGenProvider = 'openai' | 'xai'

export interface ImageGenConfig {
  enabled: boolean
  defaultProvider: ImageGenProvider
  /** Which providers currently have a key configured. */
  configuredProviders: ImageGenProvider[]
}

export type ImageGenResult =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; reason: string }

export interface ImageGenExecutorDeps {
  getConfig: () => ImageGenConfig
  generate: (input: {
    provider: ImageGenProvider
    prompt: string
    size?: string
  }) => Promise<ImageGenResult>
}

export interface ImageGenExecutor {
  executeImageGen: (rawArgs: unknown) => Promise<McpToolExecutionResult>
}

const MAX_PROMPT_CHARS = 4000

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function fail(message: string): McpToolExecutionResult {
  const value = { ok: false, tool: 'image_generate', error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

export function createImageGenExecutor(deps: ImageGenExecutorDeps): ImageGenExecutor {
  async function executeImageGen(rawArgs: unknown): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    const config = deps.getConfig()
    if (!config.enabled) {
      return fail(
        'image generation is disabled. Enable it in TaskWraith Settings and add an API key first.'
      )
    }
    if (config.configuredProviders.length === 0) {
      return fail('no image-generation API key is configured. Add one in TaskWraith Settings.')
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) return fail('a non-empty `prompt` is required')
    if (prompt.length > MAX_PROMPT_CHARS) {
      return fail(`prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS})`)
    }
    const requested = typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : ''
    let provider: ImageGenProvider
    if (requested === 'openai' || requested === 'xai') {
      if (!config.configuredProviders.includes(requested)) {
        return fail(`no API key configured for provider "${requested}"`)
      }
      provider = requested
    } else {
      provider = config.configuredProviders.includes(config.defaultProvider)
        ? config.defaultProvider
        : config.configuredProviders[0]
    }
    const size = typeof args.size === 'string' ? args.size.trim() : undefined

    let result: ImageGenResult
    try {
      result = await deps.generate({ provider, prompt, size })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    if (!result.ok) return fail(result.reason)

    // C2: the bytes returned to the model must be a real raster image.
    const sniffed = sniffImageMime(result.buffer)
    if (!isTranscriptRasterImageMime(sniffed) || isTranscriptSvgMime(sniffed)) {
      return fail('generation returned something that is not a raster image')
    }
    if (result.buffer.byteLength > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES) {
      return fail('generated image is too large')
    }
    const value = {
      ok: true,
      tool: 'image_generate',
      provider,
      mimeType: result.mimeType,
      byteLength: result.buffer.byteLength
    }
    const text = JSON.stringify(value)
    const block: McpToolContentBlock = {
      type: 'image',
      mimeType: result.mimeType,
      data: result.buffer.toString('base64')
    }
    return { text, structuredContent: value, content: [{ type: 'text', text }, block] }
  }

  return { executeImageGen }
}
