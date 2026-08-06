// Which provider lanes can actually put an attached image in front of the
// model, and the no-silent-omission warning copy for the lanes that cannot.
//
// Doctrine: a run is never dispatched with an attachment silently omitted.
// Either the lane delivers the image (each mechanism named below so the claim
// is auditable), or the images are stripped and the user gets an explicit
// warning while the text turn continues. Pure module — no Electron/fs
// imports — so the matrix is unit-testable.

import type { ProviderId } from './store/types'

/**
 * Delivery mechanisms, per lane:
 * - claude: Agent SDK streaming input — base64 image content blocks on the
 *   initial user message (ClaudeImageContent.ts). The CLI fallback cannot
 *   carry images and omits with a warning instead of dropping them silently.
 * - codex: `codex exec --image <path>` (native flag).
 * - gemini: API lane sends inline image parts (GeminiApiProvider
 *   loadImageParts); CLI lane grants read access via --include-directories
 *   and the prompt names the attached files so the model knows to read them.
 * - kimi: wire prompt user_input content parts (image_url → local path).
 * - Everything else has no image transport today. ollama could grow one for
 *   multimodal tags (API `images` field) — until then images are omitted with
 *   a visible warning rather than failing the whole turn.
 */
const PROVIDER_IMAGE_ATTACHMENT_DELIVERY: Record<ProviderId, boolean> = {
  claude: true,
  codex: true,
  gemini: true,
  kimi: true,
  ollama: false,
  cursor: false,
  grok: false,
  pi: false,
  mistral: false,
  antigravity: false
}

export function providerDeliversImageAttachments(provider: string): boolean {
  return PROVIDER_IMAGE_ATTACHMENT_DELIVERY[provider as ProviderId] === true
}

export function describeImageAttachmentOmissionWarning(
  providerLabel: string,
  imageCount: number
): string {
  const noun = imageCount === 1 ? 'the attached image' : `the ${imageCount} attached images`
  const pronoun = imageCount === 1 ? 'it' : 'them'
  return (
    `${providerLabel} cannot receive image attachments, so ${noun} ` +
    `will not be delivered to the model. Continuing without ${pronoun}. ` +
    `Remove the attachment or switch to a provider that supports images ` +
    `(Claude, Codex, Gemini, or Kimi).`
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
  providerLabel: string
): { imagePaths: string[]; warning?: string } {
  const paths = imagePaths.map((imagePath) => imagePath.trim()).filter(Boolean)
  if (paths.length === 0) return { imagePaths: [] }
  if (providerDeliversImageAttachments(provider)) {
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
