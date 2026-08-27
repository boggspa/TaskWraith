// Which provider lanes can actually put an attached image in front of the
// model, and the no-silent-omission warning copy for the lanes that cannot.
//
// Doctrine: a run is never dispatched with an attachment silently omitted.
// Either the lane delivers the image (each mechanism named below so the claim
// is auditable), or the images are stripped and the user gets an explicit
// warning while the text turn continues. Pure module — no Electron/fs
// imports — so the matrix is unit-testable.

import type { ProviderId } from './store/types'
import { findPiStaticModel, PI_DEFAULT_MODEL_WIRE_ID } from './pi/PiModels'

// Mirrors the committed wire-id validator at the combined AntiGravity
// dispatch seam. Broader namespace candidates are quarantined there only to
// fail visibly; they are not evidence of a working image transport.
const ANTIGRAVITY_GEMINI_API_IMAGE_ROUTE = /^gemini-api:gemini-[a-z0-9][a-z0-9._-]{0,127}$/

/**
 * Delivery mechanisms, per lane:
 * - claude: Agent SDK streaming input — base64 image content blocks on the
 *   initial user message (ClaudeImageContent.ts). The CLI fallback cannot
 *   carry images and omits with a warning instead of dropping them silently.
 * - codex: `codex exec --image <path>` (native flag).
 * - gemini: API lane sends inline image parts (GeminiApiProvider
 *   loadImageParts); CLI lane grants read access via --include-directories
 *   and the prompt names the attached files so the model knows to read them.
 * - kimi, grok, mistral: standard ACP image content blocks after the exact
 *   runtime advertises `agentCapabilities.promptCapabilities.image=true`.
 * - ollama: runtime-negotiated against the exact model's `/api/show`
 *   capabilities, then REST `/api/chat` `messages[].images` for vision models.
 * - pi: RPC `prompt.images` content blocks, only when the selected Pi model's
 *   curated catalog row declares image input.
 * - antigravity: only exact `gemini-api:gemini-*` routes use the existing
 *   Gemini API inline-image transport; the official agy lane has none.
 * - Everything else has no image transport today.
 */
const PROVIDER_IMAGE_ATTACHMENT_DELIVERY: Record<ProviderId, boolean> = {
  claude: true,
  codex: true,
  gemini: true,
  kimi: true,
  ollama: true,
  cursor: false,
  grok: true,
  pi: true,
  mistral: true,
  muse: false,
  antigravity: false
}

export function providerDeliversImageAttachments(provider: string, model?: string): boolean {
  if (provider === 'pi') {
    const normalizedModel =
      !model || model === 'cli-default' || model === 'default' ? PI_DEFAULT_MODEL_WIRE_ID : model
    return findPiStaticModel(normalizedModel)?.images === true
  }
  if (provider === 'antigravity') {
    return typeof model === 'string' && ANTIGRAVITY_GEMINI_API_IMAGE_ROUTE.test(model.trim())
  }
  return PROVIDER_IMAGE_ATTACHMENT_DELIVERY[provider as ProviderId] === true
}

export function describeImageAttachmentOmissionWarning(
  providerLabel: string,
  imageCount: number
): string {
  const noun = imageCount === 1 ? 'the attached image' : `the ${imageCount} attached images`
  const pronoun = imageCount === 1 ? 'it' : 'them'
  return (
    `TaskWraith's current ${providerLabel} transport cannot deliver image attachments, so ${noun} ` +
    `will not be delivered to the model. Continuing without ${pronoun}. ` +
    `Remove the attachment or switch to a model and transport whose live capability ` +
    `reports image input.`
  )
}

/** @deprecated Prefer describeImageAttachmentOmissionWarning — dispatch continues. */
export function describeImageAttachmentRefusal(providerLabel: string, imageCount: number): string {
  return describeImageAttachmentOmissionWarning(providerLabel, imageCount)
}

/**
 * Strip image paths for lanes without transport and return an explicit
 * warning. Supported lanes pass paths through unchanged.
 */
export function resolveImagePathsForProvider(
  provider: string,
  imagePaths: readonly string[],
  providerLabel: string,
  model?: string
): { imagePaths: string[]; warning?: string } {
  const paths = imagePaths.map((imagePath) => imagePath.trim()).filter(Boolean)
  if (paths.length === 0) return { imagePaths: [] }
  if (providerDeliversImageAttachments(provider, model)) {
    return { imagePaths: paths }
  }
  return {
    imagePaths: [],
    warning: describeImageAttachmentOmissionWarning(providerLabel, paths.length)
  }
}

/**
 * Prompt suffix for lanes where delivery means "the model's own file tools
 * can read the attachment" (gemini CLI + --include-directories). Without
 * this the files are readable but never named, and the model truthfully
 * reports seeing no image.
 */
export function appendAttachedImageFilesNote(prompt: string, imagePaths: string[]): string {
  const paths = imagePaths.map((imagePath) => imagePath.trim()).filter(Boolean)
  if (paths.length === 0) return prompt
  const listing = paths.map((imagePath) => `- ${imagePath}`).join('\n')
  return (
    `${prompt}\n\n` +
    `The user attached ${paths.length === 1 ? 'an image file' : `${paths.length} image files`} ` +
    `to this message. Read ${paths.length === 1 ? 'it' : 'them'} with your file tools before ` +
    `answering:\n${listing}`
  )
}
