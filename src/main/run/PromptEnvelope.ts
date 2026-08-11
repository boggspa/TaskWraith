import { createHash } from 'crypto'
import type {
  PromptEnvelopeLayerSnapshot,
  PromptEnvelopeSnapshot,
  WirePromptCapture
} from '../../shared/instructions/InstructionTypes'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Finalize a per-run prompt-envelope snapshot from the pure compose result.
 *
 * Lives in MAIN (not PromptComposition, which is renderer-importable and must
 * stay free of Node crypto): adds per-layer digests + byte counts, then
 * strips layer content unless the user's raw-event storage setting is on.
 * Metadata — sources, digests, sizes, applied/skipped states — persists
 * regardless; that split is the product's privacy contract for prompt
 * snapshots.
 */
export function buildPromptEnvelopeSnapshot(args: {
  provider: string
  model?: string
  composedPrompt: string
  layers: PromptEnvelopeLayerSnapshot[]
  /** ResolvedInstructionContext.digest ('none' when nothing applied). */
  instructionsDigest: string
  /** settings.storeRawEvents === true */
  storeContent: boolean
  composedAt?: string
}): PromptEnvelopeSnapshot {
  const layers = args.layers.map((layer) => {
    const content = layer.content
    const withDigest: PromptEnvelopeLayerSnapshot = {
      ...layer,
      ...(content !== undefined && layer.sha256 === undefined
        ? { sha256: sha256Hex(content) }
        : {}),
      ...(content !== undefined && layer.bytes === undefined
        ? { bytes: Buffer.byteLength(content, 'utf8') }
        : {})
    }
    if (args.storeContent || content === undefined) return withDigest
    const { content: _stripped, ...redacted } = withDigest
    return redacted
  })
  return {
    version: 1,
    composedAt: args.composedAt || new Date().toISOString(),
    provider: args.provider,
    ...(args.model ? { model: args.model } : {}),
    accuracy: 'composed',
    layers,
    composedSha256: sha256Hex(args.composedPrompt),
    composedBytes: Buffer.byteLength(args.composedPrompt, 'utf8'),
    contentStored: args.storeContent,
    instructionsDigest: args.instructionsDigest
  }
}

/**
 * Append a wire-boundary capture to an existing envelope (never overwrite —
 * retries and transport fallbacks each add their own attempt). Content is
 * included only when the envelope itself stored content, keeping one privacy
 * decision for the whole snapshot.
 */
export function appendWirePromptCapture(
  envelope: PromptEnvelopeSnapshot,
  capture: Omit<WirePromptCapture, 'sha256' | 'bytes' | 'attempt'> & {
    text: string
    attempt?: number
  }
): PromptEnvelopeSnapshot {
  const { text, ...rest } = capture
  const attempt = capture.attempt ?? (envelope.wire?.length || 0) + 1
  const entry: WirePromptCapture = {
    ...rest,
    attempt,
    sha256: sha256Hex(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    ...(envelope.contentStored ? { content: text } : {})
  }
  return {
    ...envelope,
    accuracy: 'wire',
    wire: [...(envelope.wire || []), entry]
  }
}
